import path, { resolve } from "node:path";
import { spawn, type SpawnOptions } from "node:child_process";
import type { Readable } from "node:stream";
import readline from "node:readline";
import http from "node:http";
import net from "node:net";
import { type FSWatcher, watch } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";

import { fileURLToPath } from "node:url";

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

export interface MinimalChildProcess {
  stdout: Readable | null;
  stderr: Readable | null;
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: string, listener: (...args: any[]) => void): this;
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): this;
  on(event: "disconnect", listener: () => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): this;
  on(event: "spawn", listener: () => void): this;
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
  onSpawn?: (process: MinimalChildProcess) => void;

  /**
   * Provide an alternative spawn functions. Defaults to child_process.spawn.
   */
  spawnFunc: (
    command: string,
    args: string[],
    options: SpawnOptions
  ) => MinimalChildProcess;
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
    spawnFunc: spawn,
    ...options,
  };

  let scriptArgs: string[];

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

  // Create the socket location that we'll use to communicate with Deno. The
  // socket file gets a private directory (instead of living directly in
  // os.tmpdir()) so that the fs.watch readiness detection below only receives
  // events for this worker's socket. Watching the shared tmpdir would wake
  // every pending worker's watcher for every temp file created by anything
  // else on the machine. This directory is created last, after every other
  // failable setup step above, so a setup error can't leak it; from here on,
  // the process "exit" handler and worker._terminate() remove it.
  const socketDir = await fs.mkdtemp(path.join(os.tmpdir(), "deno-http-"));
  // The directory is already unique, so the socket file gets a short fixed
  // name: unix socket paths are limited to ~104 bytes on macOS (SUN_LEN) and
  // the old `${randomUUID()}-deno-http.sock` name plus the new directory
  // component overflows that limit and makes Deno's listen() throw.
  const socketFile = path.join(socketDir, "deno-http.sock");

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

      const process = _options.spawnFunc(command, args, _options.spawnOptions);
      let running = false;
      let exited = false;
      let worker: DenoHTTPWorker | undefined;
      process.on("exit", (code: number, signal: string) => {
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
          fs.rm(socketDir, { recursive: true, force: true }).catch(() => {});
        } else {
          (worker as denoHTTPWorker)._terminate(code, signal);
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

      // Wait for the socket file to be created by the Deno process, using a
      // filesystem watcher on the private directory that will contain it.
      try {
        await new Promise<void>((ready, failed) => {
          let settled = false;
          let watcher: FSWatcher | undefined;
          let fallbackPoll: NodeJS.Timeout | undefined;
          // Every outcome must run through settle: an open FSWatcher (or a
          // live interval) keeps the Node event loop alive, so leaking one on
          // any path would hang the host process on shutdown.
          const settle = (err?: Error) => {
            if (settled) {
              return;
            }
            settled = true;
            watcher?.close();
            clearInterval(fallbackPoll);
            if (err) {
              failed(err);
            } else {
              ready();
            }
          };
          // A watch event only tells us that something happened in the
          // directory, not that our socket exists: on Linux (inotify) file
          // creation is reported as a "rename" event, on macOS
          // (FSEvents/kqueue) event types vary, and the filename argument is
          // not guaranteed to be provided on every platform. So we ignore
          // both arguments and stat the socket file on every event.
          const checkForSocketFile = () => {
            fs.stat(socketFile).then(
              () => settle(),
              () => {
                // Not there yet; keep waiting for the next event.
              }
            );
          };
          try {
            watcher = watch(socketDir, checkForSocketFile);
          } catch (err) {
            settle(err as Error);
            return;
          }
          // Without this, a watcher error (e.g. hitting the inotify watch or
          // file-descriptor limit) would leave this promise pending forever.
          watcher.on("error", (err) => settle(err));
          // fs.watch gives us no signal when the Deno process dies before
          // ever creating the socket, so wire the process exit to settle this
          // wait too. The "exit" handler above has already rejected the outer
          // promise with EarlyExitDenoHTTPWorkerError; the rejection from
          // settle is harmlessly swallowed by that already-settled promise.
          process.on("exit", () =>
            settle(new Error("Deno exited before being ready"))
          );
          if (exited) {
            // The process exited before the listener above was registered, so
            // that listener will never fire; settle now.
            settle(new Error("Deno exited before being ready"));
            return;
          }
          // fs.watch is documented as not perfectly reliable, and on macOS
          // the FSEvents stream starts asynchronously, so an event landing in
          // the window right after watch() returns can be missed. A coarse
          // fallback poll bounds the damage of any missed event at 250ms
          // instead of hanging forever. (Yes: a robust fs.watch needs the
          // poll it was supposed to replace, kept only as a safety net.)
          fallbackPoll = setInterval(checkForSocketFile, 250);
          // The socket file may also have been created in the window between
          // spawn and the watcher being established, in which case no event
          // will ever fire for it. Check once, now that the watcher is in
          // place, so the file can't slip through unobserved.
          checkForSocketFile();
        });
      } catch (err) {
        if (!exited) {
          // A watcher failure is an error path the poll/connect designs don't
          // have: the Deno process is still alive and nothing else will reap
          // it, so kill it before rejecting. The "exit" handler above then
          // removes the socket directory.
          process.kill("SIGKILL");
        }
        throw err;
      }

      // The socket file existing does not prove the socket is accepting
      // connections: the file can appear before Deno's listen() has
      // completed. Confirm with a connect attempt, retrying every 1ms until
      // it succeeds. Note that this reintroduces a slice of the connect-retry
      // loop from #120 — a watch event alone is not a sufficient readiness
      // signal.
      for (;;) {
        if (exited) {
          // The "exit" handler above has already rejected this promise with
          // EarlyExitDenoHTTPWorkerError. Throw (harmlessly swallowed by the
          // settled promise) instead of falling through and constructing a
          // worker whose http.Agent would never be destroyed.
          throw new Error("Deno exited before being ready");
        }
        const connected = await new Promise<boolean>((resolve) => {
          const socket = net.connect({ path: socketFile });
          socket.once("connect", () => {
            socket.destroy();
            resolve(true);
          });
          socket.once("error", () => {
            socket.destroy();
            resolve(false);
          });
        });
        if (connected) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      worker = new denoHTTPWorker(socketFile, process, stdout, stderr);
      running = true;
      try {
        await (worker as denoHTTPWorker).warmRequest();
      } catch (err) {
        // Clean up the worker (destroying its http.Agent) if the warm
        // request fails, e.g. because the process died right after the
        // socket came up.
        (worker as denoHTTPWorker)._terminate();
        throw err;
      }

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
  terminate(): void;

  /**
   * Gracefully shuts down the worker process and waits for any unresolved
   * promises to exit.
   */
  shutdown(): void;

  /**
   * request calls http.request but patches the options to work with our
   * connection pool and safely handle rewriting various headers.
   */
  request(
    url: string | URL,
    options: http.RequestOptions,
    callback: (response: http.IncomingMessage) => void
  ): http.ClientRequest;

  get stdout(): Readable;

  get stderr(): Readable;

  /**
   * Adds the given listener for the "exit" event.
   */
  addEventListener(type: "exit", listener: OnExitListener): void;
}

class denoHTTPWorker {
  #onexitListeners: OnExitListener[];
  #process: MinimalChildProcess;
  #socketFile: string;
  #stderr: Readable;
  #stdout: Readable;
  #terminated = false;
  #agent: http.Agent;

  constructor(
    socketFile: string,
    process: MinimalChildProcess,
    stdout: Readable,
    stderr: Readable
  ) {
    this.#onexitListeners = [];
    this.#process = process;
    this.#socketFile = socketFile;
    this.#stderr = stderr;
    this.#stdout = stdout;
    this.#agent = new http.Agent({ keepAlive: true });
  }

  _terminate(code?: number, signal?: string) {
    if (this.#terminated) {
      return;
    }
    this.#terminated = true;
    if (this.#process && this.#process.exitCode === null) {
      forceKill(this.#process.pid!);
    }
    this.#agent.destroy();
    // The socket file lives in a private directory created by
    // newDenoHTTPWorker (for the fs.watch readiness detection); remove the
    // whole directory, not just the socket file.
    fs.rm(path.dirname(this.#socketFile), {
      recursive: true,
      force: true,
    }).catch(() => {});
    for (const onexit of this.#onexitListeners) {
      onexit(code ?? 1, signal ?? "");
    }
  }

  terminate() {
    this._terminate();
  }

  shutdown() {
    this.#process.kill("SIGINT");
  }

  request(
    url: string | URL,
    options: http.RequestOptions,
    callback: (response: http.IncomingMessage) => void
  ): http.ClientRequest {
    options.headers = (options.headers || {}) as http.OutgoingHttpHeaders;

    // TODO: ensure these are handled with the correct casing?
    delete options.headers["x-deno-worker-host"];
    delete options.headers["x-deno-worker-connection"];

    // NodeJS will send both the host and the connection headers
    // (https://nodejs.org/api/http.html#new-agentoptions). We don't want these
    // to make it to Deno unless they are explicitly set by the user. So store
    // them to reconstruct on the other size.
    if (options.headers.host) {
      options.headers["X-Deno-Worker-Host"] = options.headers.host;
    }
    if (options.headers.connection) {
      options.headers["X-Deno-Worker-Connection"] = options.headers.connection;
    }

    options.headers = {
      ...options.headers,
      "X-Deno-Worker-URL": typeof url === "string" ? url : url.toString(),
    };
    url = "http://deno";
    options.agent = this.#agent;
    options.socketPath = this.#socketFile;
    return http.request(url, options, callback);
  }

  // We send this request to Deno so that we get a live connection in the
  // http.Agent and subsequent requests are do not have to wait for a new
  // connection.
  async warmRequest() {
    return new Promise<void>((resolve, reject) => {
      const req = http.request(
        "http://deno",
        { agent: this.#agent, socketPath: this.#socketFile },
        (resp) => {
          resp.on("error", reject);
          resp.on("data", () => {});
          resp.on("close", () => {
            resolve();
          });
        }
      );
      req.on("error", reject);
      req.end();
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
