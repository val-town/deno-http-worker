import { resolve } from "https://deno.land/std@0.208.0/path/mod.ts";
import { crypto } from "https://deno.land/std@0.208.0/crypto/mod.ts";

const DEFAULT_DENO_BOOTSTRAP_SCRIPT_PATH = resolve(
  new URL(import.meta.url).pathname,
  "../../bootstrap/index.ts"
);

type OnExitListener = (exitCode: number, signal: string) => void;

export class EarlyExitDenoHTTPWorkerError extends Error {
  constructor(
    public override message: string,
    public stderr: string,
    public stdout: string,
    public code: number,
    public signal: string
  ) {
    super(message);
  }
}

export interface MinimalChildProcess {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  readonly pid: number;
  readonly status: Promise<Deno.CommandStatus>;
  kill(signal?: Deno.Signal): void;
}

export interface DenoWorkerOptions {
  denoExecutable: string | string[];
  denoBootstrapScriptPath: string;
  runFlags: string[];
  printOutput: boolean;
  printCommandAndArguments: boolean;
  onSpawn?: (childProcess: MinimalChildProcess) => void;
  spawnFunc: (
    command: string,
    args: string[]
  ) => MinimalChildProcess;
}

export const newDenoHTTPWorker = (
  script: string | URL,
  options: Partial<DenoWorkerOptions> = {}
): Promise<DenoHTTPWorker> => {
  const _options: DenoWorkerOptions = {
    denoExecutable: "deno",
    denoBootstrapScriptPath: DEFAULT_DENO_BOOTSTRAP_SCRIPT_PATH,
    runFlags: [],
    printCommandAndArguments: false,
    printOutput: false,
    spawnFunc: (command: string, args: string[]) => {
      const cmd = new Deno.Command(command, {
        args,
        stdout: "inherit",
        stderr: "inherit"
      });
      const child = cmd.spawn();
      return {
        // stdout: child.stdout,
        // stderr: child.stderr,
        stdout: null,
        stderr: null,
        pid: child.pid,
        status: child.status,
        kill: (signal?: Deno.Signal) => child.kill(signal)
      };
    },
    ...options,
  };

  let scriptArgs: string[];

  // Create the socket location that we'll use to communicate with Deno.
  const socketFile = resolve(
    Deno.env.get("TMPDIR") || "/tmp",
    `${crypto.randomUUID()}-deno-http.sock`
  );

  // If we have a file import, make sure we allow read access to the file.
  const allowReadFlagValue =
    typeof script === "string"
      ? socketFile
      : `${socketFile},${script.href.replace("file://", "")}`;

  let allowReadFound = false;
  let allowWriteFound = false;
  _options.runFlags = _options.runFlags.map((flag) => {
    if (flag === "--allow-read" || flag === "--allow-all") {
      allowReadFound = true;
    }
    if (flag === "--allow-write" || flag === "--allow-all") {
      allowWriteFound = true;
    }
    if (flag.startsWith("--allow-read=")) {
      allowReadFound = true;
      return (flag += `,${allowReadFlagValue}`);
    }
    if (flag.startsWith("--allow-write=")) {
      allowWriteFound = true;
      return (flag += `,${socketFile}`);
    }
    return flag;
  });
  if (!allowReadFound) {
    _options.runFlags.push(`--allow-read=${allowReadFlagValue}`);
  }
  if (!allowWriteFound) {
    _options.runFlags.push(`--allow-write=${socketFile}`);
  }

  if (typeof script === "string") {
    scriptArgs = [socketFile, "script", script];
  } else {
    scriptArgs = [socketFile, "import", script.href];
  }
  if (
    Array.isArray(_options.denoExecutable) &&
    _options.denoExecutable.length === 0
  ) {
    throw new Error("denoExecutable must not be an empty array");
  }
  const command =
    typeof _options.denoExecutable === "string"
      ? _options.denoExecutable
      : (_options.denoExecutable[0] as string);

  return new Promise((resolve, reject) => {
    (async (): Promise<DenoHTTPWorker> => {
      const args = [
        ...(typeof _options.denoExecutable === "string"
          ? []
          : _options.denoExecutable.slice(1)),
        "run",
        ..._options.runFlags,
        _options.denoBootstrapScriptPath,
        ...scriptArgs,
      ];
      if (_options.printCommandAndArguments) {
        console.log("Spawning deno process:", [command, ...args]);
      }

      const process = _options.spawnFunc(command, args);
      let running = false;
      let exited = false;
      let worker: DenoHTTPWorker | undefined = undefined;

      // Handle process exit
      process.status.then(async (status) => {
        exited = true;
        if (!running) {
          reject(
            new EarlyExitDenoHTTPWorkerError(
              "Deno exited before being ready",
              "", // TODO: capture stderr
              "", // TODO: capture stdout
              status.code,
              status.signal || ""
            )
          );
          Deno.remove(socketFile).catch(() => {});
        } else {
          await (worker as DenoHTTPWorkerImpl)._terminate(status.code, status.signal || "");
        }
      });

      options.onSpawn && options.onSpawn(process);

      if (_options.printOutput) {
        // TODO: Implement output reading similar to Node.js version
      }

      // Wait for the socket file to be created by the Deno process.
      for (;;) {
        if (exited) {
          break;
        }
        try {
          await Deno.stat(socketFile);
          // File exists
          break;
        } catch (_err) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      worker = new DenoHTTPWorkerImpl(socketFile, process);
      running = true;
      await (worker as DenoHTTPWorkerImpl).warmRequest();

      return worker;
    })()
      .then(resolve)
      .catch(reject);
  });
};

export interface DenoHTTPWorker {
  terminate(): Promise<void>;
  shutdown(): void;
  fetch(request: Request): Promise<Response>;
  get stdout(): ReadableStream<Uint8Array> | null;
  get stderr(): ReadableStream<Uint8Array> | null;
  addEventListener(type: "exit", listener: OnExitListener): void;
}


class DenoHTTPWorkerImpl implements DenoHTTPWorker {
  #onexitListeners: OnExitListener[];
  #process: MinimalChildProcess;
  #socketFile: string;
  #terminated = false;
  #httpClient: Deno.HttpClient;

  constructor(
    socketFile: string,
    process: MinimalChildProcess
  ) {
    this.#onexitListeners = [];
    this.#process = process;
    this.#socketFile = socketFile;
    this.#httpClient = Deno.createHttpClient({
      proxy: {
        transport: "unix",
        path: socketFile,
      },
    });
  }

  async _terminate(code?: number, signal?: string) {
    if (this.#terminated) {
      return;
    }
    this.#terminated = true;

    this.#httpClient.close();

    // Only kill if the process hasn't already exited
    try {
      this.#process.kill("SIGKILL");
    } catch (_error) {
      // Process may have already terminated, ignore error
    }

    // Wait for the process to actually exit
    try {
      const status = await this.#process.status;
      code = code ?? status.code;
      signal = signal ?? status.signal ?? "";
    } catch (_error) {
      // If we can't get the status, use the provided values or defaults
      code = code ?? 1;
      signal = signal ?? "";
    }

    Deno.remove(this.#socketFile).catch(() => {});

    for (const onexit of this.#onexitListeners) {
      onexit(code, signal);
    }
  }

  async terminate() {
    await this._terminate();
  }

  shutdown() {
    this.#process.kill("SIGINT");
  }

  async fetch(request: Request): Promise<Response> {
    // Create a new request with the required headers for the bootstrap script
    const modifiedRequest = new Request("http://deno", {
      method: request.method,
      headers: {
        ...Object.fromEntries(request.headers.entries()),
        "X-Deno-Worker-URL": request.url,
        // Preserve original host and connection headers if they exist
        ...(request.headers.has("host") ? { "X-Deno-Worker-Host": request.headers.get("host")! } : {}),
        ...(request.headers.has("connection") ? { "X-Deno-Worker-Connection": request.headers.get("connection")! } : {}),
      },
      body: request.body,
    });

    // Use the HTTP client to make the request through the Unix socket
    return await fetch(modifiedRequest, { client: this.#httpClient });
  }

  async warmRequest(): Promise<void> {
    // For warm request, don't include X-Deno-Worker-URL header
    const warmReq = new Request("http://deno");
    const response = await fetch(warmReq, { client: this.#httpClient });
    await response.body?.cancel();
  }

  get stdout() {
    return this.#process.stdout;
  }

  get stderr() {
    return this.#process.stderr;
  }

  addEventListener(_type: "exit", listener: OnExitListener): void {
    this.#onexitListeners.push(listener as OnExitListener);
  }
}
