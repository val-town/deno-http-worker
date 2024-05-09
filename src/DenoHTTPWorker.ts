import path, { resolve } from "path";
import { ChildProcess, spawn, SpawnOptions, execSync } from "child_process";
import { Readable, Writable, TransformCallback, Transform } from "stream";
import readline from "readline";
import http2 from "http2-wrapper";
import got, { Got } from "got";
import fs from "fs/promises";
import net from "net";

import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DENO_PORT_LOG_PREFIX = "deno-listening-port";
const LISTENING_HOSTPORT = "0.0.0.0:0";

const DEFAULT_DENO_BOOTSTRAP_SCRIPT_PATH = __dirname.endsWith("src")
  ? resolve(__dirname, "../deno-bootstrap/index.ts")
  : resolve(__dirname, "../../deno-bootstrap/index.ts");

interface OnExitListener {
  (exitCode: number, signal: string): void;
}

export interface DenoWorkerOptions {
  /**
   * The path to the executable that should be use when spawning the subprocess.
   * Defaults to "deno".
   */
  denoExecutable: string;

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
}

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
  const socketFile = `${crypto.randomUUID()}-deno-http.sock`;

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
      return (flag += "," + allowReadFlagValue);
    }
    if (flag.startsWith("--allow-write=")) {
      allowWriteFound = true;
      return (flag += "," + socketFile);
    }
    return flag;
  });
  if (!allowReadFound) {
    _options.runFlags.push("--allow-read=" + allowReadFlagValue);
  }
  if (!allowWriteFound) {
    _options.runFlags.push("--allow-write=" + socketFile);
  }

  if (typeof script === "string") {
    scriptArgs = [socketFile, "script", script];
  } else {
    scriptArgs = [socketFile, "import", script.href];
  }

  const command = _options.denoExecutable;

  return new Promise(async (resolve, reject) => {
    const args = [
      "run",
      ..._options.runFlags,
      _options.denoBootstrapScriptPath,
      ...scriptArgs,
    ];
    if (_options.printCommandAndArguments) {
      console.log("Spawning deno process:", [command, ...args]);
    }
    const process = spawn(command, args, _options.spawnOptions);
    let running = false;
    let exited = false;
    let worker: DenoHTTPWorker;
    process.on("exit", (code: number, signal: string) => {
      exited = true;
      if (!running) {
        let stderr = process.stderr?.read()?.toString();
        reject(
          new Error(
            `Deno process exited before it was ready: code: ${code}, signal: ${signal}` +
              (stderr ? `\n${stderr}` : "")
          )
        );
        fs.rm(socketFile);
      } else {
        worker.terminate(code, signal);
      }
    });

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
    while (true) {
      if (exited) {
        break;
      }
      try {
        await fs.stat(socketFile);
        // File exists
        break;
      } catch (err) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    const _httpSession = http2.connect(`http://whatever`, {
      createConnection: () => net.connect(socketFile),
    });
    _httpSession.on("error", (err) => {
      if (!running) {
        reject(err);
      } else {
        worker.terminate();
        throw err;
      }
    });
    _httpSession.on("connect", () => {
      const _got = got.extend({
        hooks: {
          beforeRequest: [
            (options) => {
              // Ensure that we use our existing session
              options.h2session = _httpSession;
              options.http2 = true;

              // We follow Got's example here:
              // https://github.com/sindresorhus/got/blob/88e623a0d8140e02eef44d784f8d0327118548bc/documentation/examples/h2c.js#L32-L34
              // But, this still surfaces a type error for various
              // differences between the implementation. Ignoring for now.
              //
              // @ts-ignore
              options.request = http2.request;

              // Ensure the Got user-agent string is never present. If a
              // value is passed by the user it will override got's
              // default value.
              if (
                options.headers["user-agent"] ===
                "got (https://github.com/sindresorhus/got)"
              ) {
                delete options.headers["user-agent"];
              }

              // Got will block requests that have a scheme of https and
              // will also add a :443 port when not port exists. We pass
              // the parts of the url that we care about in headers so
              // that we can successfully assemble the request on the
              // other side.
              if (typeof options.url === "string") {
                options.url = new URL(options.url);
              }
              options.headers = {
                ...options.headers,
                "X-Deno-Worker-Host": options.url?.host,
                "X-Deno-Worker-Port": options.url?.port,
                "X-Deno-Worker-Protocol": options.url?.protocol,
              };
              if (options.url && options.url?.protocol === "https:") {
                options.url.protocol = "http:";
              }
            },
          ],
        },
      });

      worker = new DenoHTTPWorker(
        _httpSession,
        socketFile,
        _got,
        process,
        stdout,
        stderr
      );
      running = true;
      resolve(worker);
    });
  });
};
export type { DenoHTTPWorker };

class DenoHTTPWorker {
  #got: Got;
  #httpSession: http2.ClientHttp2Session;
  #onexitListeners: OnExitListener[];
  #process: ChildProcess;
  #socketFile: string;
  #stderr: Readable;
  #stdout: Readable;
  #terminated: Boolean = false;

  constructor(
    httpSession: http2.ClientHttp2Session,
    socketFile: string,
    got: Got,
    process: ChildProcess,
    stdout: Readable,
    stderr: Readable
  ) {
    this.#got = got;
    this.#httpSession = httpSession;
    this.#onexitListeners = [];
    this.#process = process;
    this.#socketFile = socketFile;
    this.#stderr = stderr;
    this.#stdout = stdout;
  }

  get client(): Got {
    return this.#got;
  }

  terminate(code?: number, signal?: string) {
    if (this.#terminated) {
      return;
    }
    this.#terminated = true;
    if (this.#process && this.#process.exitCode === null) {
      // TODO: do we need to SIGINT first to make sure we allow the process to do
      // any cleanup?
      forceKill(this.#process.pid!);
    }
    this.#httpSession.close();
    fs.rm(this.#socketFile);
    for (let onexit of this.#onexitListeners) {
      onexit(code ?? 1, signal ?? "");
    }
  }

  /**
   * Gracefully shuts down the worker process and waits for any unresolved
   * promises to exit.
   */
  shutdown() {
    this.#process.kill("SIGINT");
  }

  get stdout() {
    return this.#stdout;
  }

  get stderr() {
    return this.#stderr;
  }

  /**
   * Adds the given listener for the "exit" event.
   * @param type The type of the event. (Always "exit")
   * @param listener The listener to add for the event.
   */
  addEventListener(type: "exit", listener: OnExitListener): void {
    this.#onexitListeners.push(listener as OnExitListener);
  }
}

/**
 * Forcefully kills the process with the given ID.
 * On Linux/Unix, this means sending the process the SIGKILL signal.
 */
export function forceKill(pid: number) {
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
