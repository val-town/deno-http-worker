import path, { resolve } from "node:path";
import {
  type ChildProcess,
  spawn,
  type SpawnOptions,
} from "node:child_process";
import type { Readable } from "node:stream";
import readline from "node:readline";
import fs from "node:fs/promises";
import os from "node:os";

import { fileURLToPath } from "node:url";
import undici, { WebSocket } from "undici";
import type { ResponseData, RequestOptions } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_DENO_BOOTSTRAP_SCRIPT_PATH = resolve(
  __dirname,
  "../deno-bootstrap/index.ts"
);

type OnExitListener = (exitCode: number, signal: string) => void;

export class EarlyExitDenoHTTPWorkerError extends Error {
  constructor(
    public message: string,
    public stderr: string,
    public stdout: string,
    public code: number,
    public signal: string
  ) {
    super(message);
  }
}

export interface DenoWorkerOptions {
  /**
   * The path to the executable that should be use when spawning the subprocess.
   * Defaults to "deno".
   */
  denoExecutable: string | string[];

  /**
   * The path to the script that should be used to bootstrap the worker
   * environment in Deno. If specified, this script will be used instead of the
   * default bootstrap script. Only advanced users should set this.
   */
  denoBootstrapScriptPath: string;

  /**
   * Flags that are passed to the Deno process. These flags follow the `deno
   * run` command and can be used to enabled/disabled various permissions and
   * features. These flags will be modified to ensure that the deno process can
   * run the http server we'll be connecting to. Toggle the
   * printCommandAndArguments if you need to understand what the final flag
   * values are.
   *
   * Review Deno's available flags here:
   * https://docs.deno.com/runtime/manual/getting_started/command_line_interface
   */
  runFlags: string[];

  /**
   * Print stdout and stderr to the console with a "[deno]" prefix. This is
   * useful for debugging.
   */
  printOutput: boolean;

  /**
   * Print out the command and arguments that are executed.
   */
  printCommandAndArguments: boolean;

  /**
   * Options used to spawn the Deno child process
   */
  spawnOptions: SpawnOptions;

  /**
   * Callback that is called when the process is spawned.
   */
  onSpawn?: (process: ChildProcess) => void;
}

/**
 * Create a new DenoHTTPWorker. This function will start a worker and being
 */
export const newDenoHTTPWorker = async (
  script: string | URL,
  options: Partial<DenoWorkerOptions> = {}
): Promise<DenoHTTPWorker> => {
  const _options: DenoWorkerOptions = {
    denoExecutable: "deno",
    denoBootstrapScriptPath: DEFAULT_DENO_BOOTSTRAP_SCRIPT_PATH,
    runFlags: [],
    printCommandAndArguments: false,
    spawnOptions: {},
    printOutput: false,
    ...options,
  };

  let scriptArgs: string[];

  // Create the socket location that we'll use to communicate with Deno.
  const socketFile = path.join(
    os.tmpdir(),
    `${crypto.randomUUID()}-deno-http.sock`
  );

  // If we have a file import, make sure we allow read access to the file.
  const allowReadFlagValue =
    typeof script === "string"
      ? socketFile
      : `${socketFile},${fileURLToPath(script)}`;

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

  const bootstrap = await fs.readFile(
    _options.denoBootstrapScriptPath,
    "utf-8"
  );

  return new Promise((resolve, reject) => {
    (async (): Promise<DenoHTTPWorker> => {
      const args = [
        ...(typeof _options.denoExecutable === "string"
          ? []
          : _options.denoExecutable.slice(1)),
        "run",
        ..._options.runFlags,
        `data:text/typescript,${encodeURIComponent(bootstrap)}`,
        ...scriptArgs,
      ];
      if (_options.printCommandAndArguments) {
        console.log("Spawning deno process:", [command, ...args]);
      }

      const process = spawn(command, args, _options.spawnOptions);
      let running = false;
      let exited = false;
      // eslint-disable-next-line prefer-const
      let worker: DenoHTTPWorker | undefined;
      process.on("exit", async (code: number, signal: string) => {
        exited = true;
        if (!running) {
          const stderr = process.stderr?.read()?.toString();
          const stdout = process.stdout?.read()?.toString();
          reject(
            new EarlyExitDenoHTTPWorkerError(
              "Deno exited before being ready",
              stderr,
              stdout,
              code,
              signal
            )
          );
          await fs.rm(socketFile).catch(() => {});
        } else {
          await (worker as denoHTTPWorker)._terminate(code, signal);
        }
      });
      options.onSpawn && options.onSpawn(process);
      const stdout = <Readable>process.stdout;
      const stderr = <Readable>process.stderr;

      if (_options.printOutput) {
        readline.createInterface({ input: stdout }).on("line", (line) => {
          console.log("[deno]", line);
        });
        readline.createInterface({ input: stderr }).on("line", (line) => {
          console.error("[deno]", line);
        });
      }

      // Wait for the socket file to be created by the Deno process.
      for (;;) {
        if (exited) {
          break;
        }
        try {
          await fs.stat(socketFile);
          // File exists
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      worker = new denoHTTPWorker(socketFile, process, stdout, stderr);
      running = true;
      await (worker as denoHTTPWorker).warmRequest();

      return worker;
    })()
      .then(resolve)
      .catch(reject);
  });
};

export interface DenoHTTPWorker {
  /**
   * Terminate the worker. This kills the process with SIGKILL if it is still
   * running, closes the http2 connection, and deletes the socket file.
   */
  terminate(): Promise<void>;

  /**
   * Gracefully shuts down the worker process and waits for any unresolved
   * promises to exit.
   */
  shutdown(): Promise<void>;

  /**
   * request calls undici.request but patches the options to work with our
   * connection pool and safely handle rewriting various headers.
   */
  request: (ops: RequestOptions) => Promise<ResponseData>;

  /**
   * Opens a WebSocket connection to the given URL in the worker process.
   *
   * Note that we internally modify request headers in the proxying path, and in
   * order to achieve this for WebSockets we patch the `Deno.upgradeWebSocket`
   * method to use the original unmodified request, since Deno doesn't let us
   * use a cloned Request object.
   */
  websocket(url: string, headers?: Headers): Promise<WebSocket>;

  get stdout(): Readable;

  get stderr(): Readable;

  /**
   * Adds the given listener for the "exit" event.
   */
  addEventListener(type: "exit", listener: OnExitListener): void;
}

class denoHTTPWorker implements DenoHTTPWorker {
  #onexitListeners: OnExitListener[];
  #process: ChildProcess;
  #socketFile: string;
  #stderr: Readable;
  #stdout: Readable;
  #terminated = false;
  #pool: undici.Pool;

  constructor(
    socketFile: string,
    process: ChildProcess,
    stdout: Readable,
    stderr: Readable
  ) {
    this.#onexitListeners = [];
    this.#process = process;
    this.#socketFile = socketFile;
    this.#stderr = stderr;
    this.#stdout = stdout;

    this.#pool = new undici.Pool("http://deno", { socketPath: socketFile });
  }

  /**
   * Force-kill the process with SIGKILL, firing exit events.
   */
  async _terminate(code?: number, signal?: string) {
    if (this.#terminated) {
      return;
    }

    this.#terminated = true;
    if (this.#process && this.#process.exitCode === null) {
      forceKill(this.#process.pid!);
    }

    fs.rm(this.#socketFile).catch(() => {});
    for (const onexit of this.#onexitListeners) {
      onexit(code ?? 1, signal ?? "");
    }
  }

  async terminate() {
    return await this._terminate();
  }

  /**
   * Kill the process with SIGINT.
   * This resolves once we receive the 'exit' event from the underlying
   * process.
   */
  async shutdown() {
    this.#process.kill("SIGINT");
    await new Promise<void>((res) => {
      this.#process.on("exit", res);
    });
  }

  async websocket(
    url: string,
    headers: Headers = new Headers()
  ): Promise<WebSocket> {
    headers = processHeaders(headers, url);
    headers.set("x-deno-worker-connection", "upgrade"); // Required for websockets

    return new WebSocket(url, {
      dispatcher: this.#pool,
      headers,
    });
  }

  async request(options: RequestOptions): Promise<ResponseData> {
    const headers = processHeaders(
      options.headers || new Headers(),
      options.url
    );

    return await this.#pool
      .request({
        ...options,
        origin: "http://deno",
        path: "/",
        query: {},
        headers,
      })
      .then((resp) => ({
        statusCode: resp.statusCode,
        headers: resp.headers,
        body: resp.body,
        trailers: resp.trailers,
        context: resp.context || {},
      }));
  }

  // We send this request to Deno so that we get a live connection in the
  // http.Agent and subsequent requests are do not have to wait for a new
  // connection.
  async warmRequest() {
    return await this.#pool.request({
      origin: "http://deno",
      method: "GET",
      path: "/",
    });
  }

  get stdout() {
    return this.#stdout;
  }

  get stderr() {
    return this.#stderr;
  }

  addEventListener(_type: "exit", listener: OnExitListener): void {
    this.#onexitListeners.push(listener as OnExitListener);
  }
}

/**
 * Forcefully kills the process with the given ID.
 * On Linux/Unix, this means sending the process the SIGKILL signal.
 */
function forceKill(pid: number) {
  return killUnix(pid);
}

function killUnix(pid: number) {
  try {
    const signal = "SIGKILL";
    process.kill(pid, signal);
  } catch (e: any) {
    // Allow this call to fail with
    // ESRCH, which meant that the process
    // to be killed was already dead.
    // But re-throw on other codes.
    if (e.code !== "ESRCH") {
      throw e;
    }
  }
}

function processHeaders(headers: Headers, url: string): Headers {
  headers.set("x-deno-worker-url", url);

  // To prevent the user from setting these headers, we either update them to
  // the real host / connection, or clear them
  headers.delete("x-deno-worker-host");
  headers.delete("x-deno-worker-connection");

  const host = headers.get("host");
  if (host) {
    headers.set("x-deno-worker-host", host);
  }

  const connection = headers.get("connection");
  if (connection) {
    headers.set("x-deno-worker-connection", connection);
  }

  return headers;
}
