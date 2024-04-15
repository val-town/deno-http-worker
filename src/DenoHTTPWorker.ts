import path, { resolve } from "path";
import { ChildProcess, spawn, SpawnOptions, execSync } from "child_process";
import { Readable, Writable, TransformCallback, Transform } from "stream";
import readline from "readline";
import http2 from "http2-wrapper";
import got, { Got } from "got";

import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DENO_PORT_LOG_PREFIX = "deno-listening-port";
const LISTENING_HOSTPORT = "0.0.0.0:0";

const DEFAULT_DENO_BOOTSTRAP_SCRIPT_PATH = __dirname.endsWith("src")
  ? resolve(__dirname, "../deno-bootstrap/index.ts")
  : resolve(__dirname, "../../deno-bootstrap/index.ts");

export interface DenoWorkerOptions {
  /**
   * The path to the executable that should be use when spawning the subprocess.
   * Defaults to "deno". You can pass an array here if you want to invoke Deno
   * with multiple arguments, like `sandbox run deno`.
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
}

export const newDenoHTTPWorker = async (
  script: string | URL,
  options?: Partial<DenoWorkerOptions>
): Promise<DenoHTTPWorker> => {
  const _options: DenoWorkerOptions = Object.assign(
    {
      denoExecutable: "deno",
      denoBootstrapScriptPath: DEFAULT_DENO_BOOTSTRAP_SCRIPT_PATH,
      runFlags: [],
      printCommandAndArguments: false,
      spawnOptions: {},
      printOutput: false,
    },
    options || {}
  );

  let networkingIsOk = false;
  _options.runFlags = _options.runFlags.map((flag) => {
    if (flag === "--allow-net" || flag === "--allow-all") {
      networkingIsOk = true;
    }
    if (flag === "--deny-net") {
      throw new Error(
        "Using --deny-net without specifying specific addresses is not supported"
      );
    }
    if (flag.startsWith("--deny-net") && flag.includes(LISTENING_HOSTPORT)) {
      throw new Error(
        `Using --deny-net with the address ${LISTENING_HOSTPORT} is not supported`
      );
    }
    if (flag.startsWith("--allow-net=")) {
      networkingIsOk = true;
      return (flag += "," + LISTENING_HOSTPORT);
    }
    return flag;
  });
  if (!networkingIsOk) {
    _options.runFlags.push("--allow-net=" + LISTENING_HOSTPORT);
  }

  let scriptArgs: string[];

  if (typeof script === "string") {
    scriptArgs = ["script", script];
  } else {
    scriptArgs = ["import", script.href];
  }

  let command = "deno";
  if (typeof _options.denoExecutable === "string") {
    command = _options.denoExecutable;
  }

  if (Array.isArray(_options.denoExecutable)) {
    if (_options.denoExecutable.length === 0)
      throw new Error("denoExecutable must not be empty");

    command = _options.denoExecutable[0]!;
    _options.runFlags = [
      ..._options.denoExecutable.slice(1),
      ..._options.runFlags,
    ];
  }

  return new Promise((resolve, reject) => {
    const args = [
      "run",
      ..._options.runFlags,
      _options.denoBootstrapScriptPath,
      ...scriptArgs,
    ];
    if (_options.printCommandAndArguments) {
      console.log("Spawning deno process:", JSON.stringify([command, ...args]));
    }
    const process = spawn(command, args, _options.spawnOptions);
    let running = false;
    let worker: DenoHTTPWorker;
    process.on("exit", (code: number, signal: string) => {
      if (!running) {
        let stderr = process.stderr?.read()?.toString();
        reject(
          new Error(
            `Deno process exited before it was ready: code: ${code}, signal: ${signal}` +
              (stderr ? `\n${stderr}` : "")
          )
        );
      } else {
        worker.terminate(code, signal);
      }
    });

    const stdout = <Readable>process.stdout;
    const stderr = <Readable>process.stderr;

    const onReadable = () => {
      // We wait for stdout to be readable and then just read the bytes of the
      // port number log line. If a user subscribes to the reader later they'll
      // only see log output without the port line.

      // Length is: DENO_PORT_LOG_PREFIX + " " + port + padding + " " + newline
      let data = stdout.read(DENO_PORT_LOG_PREFIX.length + 1 + 5 + 1 + 1);
      stdout.removeListener("readable", onReadable);
      let strData = data.toString();
      if (!strData.startsWith(DENO_PORT_LOG_PREFIX)) {
        reject(
          new Error(
            "First log output from deno process did not contain the expected port value"
          )
        );
        return;
      }

      const match = strData.match(/deno-listening-port +(\d+) /);
      if (!match) {
        reject(
          new Error(
            `First log output from deno process did not contain a valid port value: "${data}"`
          )
        );
        return;
      }
      const port = match[1];
      const _httpSession = http2.connect(`http://localhost:${port}`);
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

                // We follow got's example here:
                // https://github.com/sindresorhus/got/blob/88e623a0d8140e02eef44d784f8d0327118548bc/documentation/examples/h2c.js#L32-L34
                // But, this still surfaces a type error for various
                // differences between the implementation. Ignoring for now.
                //
                // @ts-ignore
                options.request = http2.request;

                // Ensure the got user-agent string is never present. If a
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
        if (_options.printOutput) {
          readline.createInterface({ input: stdout }).on("line", (line) => {
            console.log("[deno]", line);
          });
          readline.createInterface({ input: stderr }).on("line", (line) => {
            console.error("[deno]", line);
          });
        }

        worker = new DenoHTTPWorker(
          _httpSession,
          port,
          _got,
          process,
          stdout,
          stderr
        );
        running = true;
        resolve(worker);
      });
    };
    stdout.on("readable", onReadable);
  });
};
export type { DenoHTTPWorker };

class DenoHTTPWorker {
  #httpSession: http2.ClientHttp2Session;
  #got: Got;
  #denoListeningPort: number;
  #process: ChildProcess;
  #stdout: Readable;
  #stderr: Readable;
  #terminated: Boolean = false;

  constructor(
    httpSession: http2.ClientHttp2Session,
    denoListeningPort: number,
    got: Got,
    process: ChildProcess,
    stdout: Readable,
    stderr: Readable
  ) {
    this.#httpSession = httpSession;
    this.#denoListeningPort = denoListeningPort;
    this.#got = got;
    this.#process = process;
    this.#stdout = stdout;
    this.#stderr = stderr;
  }

  get client(): Got {
    return this.#got;
  }
  terminate(code?: number, signal?: string) {
    if (this.#terminated) {
      return;
    }
    this.onexit(code || this.#process.exitCode || 0, signal || "");
    this.#terminated = true;
    if (this.#process && this.#process.exitCode === null) {
      // TODO: is this preventing listening on SIGINT for cleanup? Do we care?
      forceKill(this.#process.pid!);
    }
    this.#httpSession.close();
  }

  get stdout() {
    return this.#stdout;
  }

  get stderr() {
    return this.#stderr;
  }

  get denoListeningPort(): number {
    return this.#denoListeningPort;
  }
  /**
   * Represents an event handler for the "exit" event. That is, a function to be
   * called when the Deno worker process is terminated.
   */
  onexit: (code: number, signal: string) => void = () => {};
}

function addOption(
  list: string[],
  name: string,
  option: boolean | string[] | undefined
) {
  if (option === true) {
    list.push(`${name}`);
  } else if (Array.isArray(option)) {
    let values = option.join(",");
    list.push(`${name}=${values}`);
  }
}

/**
 * Forcefully kills the process with the given ID.
 * On Linux/Unix, this means sending the process the SIGKILL signal.
 * On Windows, this means using the taskkill executable to kill the process.
 * @param pid The ID of the process to kill.
 */
export function forceKill(pid: number) {
  // TODO: do we need to SIGINT first to make sure we allow the process to do
  // any cleanup?
  const isWindows = /^win/.test(process.platform);
  if (isWindows) {
    return killWindows(pid);
  } else {
    return killUnix(pid);
  }
}

function killWindows(pid: number) {
  execSync(`taskkill /PID ${pid} /T /F`);
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
