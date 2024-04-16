import path, { resolve } from "path";
import { ChildProcess, spawn, SpawnOptions, execSync } from "child_process";
import { Readable, TransformCallback, Transform } from "stream";
import http2 from "http2-wrapper";
import got, { Got } from "got";

import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DENO_PORT_LOG_PREFIX = "deno-listening-port";

const DEFAULT_DENO_BOOTSTRAP_SCRIPT_PATH = __dirname.endsWith("src")
  ? resolve(__dirname, "../deno-guest/index.ts")
  : resolve(__dirname, "../../deno-guest/index.ts");

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
   * Whether to reload scripts. If given a list of strings then only the
   * specified URLs will be reloaded. Defaults to false when NODE_ENV is set to
   * "production" and true otherwise.
   */
  reload: boolean | string[];

  /**
   * Whether to use Deno's unstable features
   */
  denoUnstable:
    | boolean
    | {
        /**
         * Enable unstable bare node builtins feature
         */
        bareNodeBuiltins?: boolean;

        /**
         * Enable unstable 'bring your own node_modules' feature
         */
        byonm?: boolean;

        /**
         * Enable unstable resolving of specifiers by extension probing, .js to
         * .ts, and directory probing.
         */
        sloppyImports?: boolean;

        /**
         * Enable unstable `BroadcastChannel` API
         */
        broadcastChannel?: boolean;

        /**
         * Enable unstable Deno.cron API
         */
        cron?: boolean;

        /**
         * Enable unstable FFI APIs
         */
        ffi?: boolean;

        /**
         * Enable unstable file system APIs
         */
        fs?: boolean;

        /**
         * Enable unstable HTTP APIs
         */
        http?: boolean;

        /**
         * Enable unstable Key-Value store APIs
         */
        kv?: boolean;

        /**
         * Enable unstable net APIs
         */
        net?: boolean;

        /**
         * Enable unstable Temporal API
         */
        temporal?: boolean;

        /**
         * Enable unsafe __proto__ support. This is a security risk.
         */
        unsafeProto?: boolean;

        /**
         * Enable unstable `WebGPU` API
         */
        webgpu?: boolean;

        /**
         * Enable unstable Web Worker APIs
         */
        workerOptions?: boolean;
      };

  /**
   * V8 flags to be set when starting Deno
   */
  denoV8Flags: string[];

  /**
   * Path where deno can find an import map
   */
  denoImportMapPath: string;

  /**
   * Path where deno can find a lock file
   */
  denoLockFilePath: string;

  /**
   * Whether to disable fetching uncached dependencies
   */
  denoCachedOnly: boolean;

  /**
   * Whether to disable typechecking when starting Deno
   */
  denoNoCheck: boolean;

  /**
   * Allow Deno to make requests to hosts with certificate errors.
   */
  unsafelyIgnoreCertificateErrors: boolean;

  /**
   * Specify the --location flag, which defines location.href. This must be a
   * valid URL if provided.
   */
  location?: string;

  /**
   * The permissions that the Deno worker should use.
   */
  permissions: {
    /**
     * Whether to allow all permissions.
     * Defaults to false.
     */
    allowAll?: boolean;

    /**
     * Whether to allow network connnections. If given a list of strings then
     * only the specified origins/paths are allowed. Defaults to false.
     */
    allowNet?: boolean | string[];

    /**
     * Disable network access to provided IP addresses or hostnames. Any
     * addresses specified here will be denied access, even if they are
     * specified in `allowNet`. Note that deno-vm needs a network connection
     * between the host and the guest, so it's not possible to fully disable
     * network access.
     */
    denyNet?: string[];

    /**
     * Whether to allow reading from the filesystem. If given a list of strings
     * then only the specified file paths are allowed. Defaults to false.
     */
    allowRead?: boolean | string[];

    /**
     * Whether to allow writing to the filesystem. If given a list of strings
     * then only the specified file paths are allowed. Defaults to false.
     */
    allowWrite?: boolean | string[];

    /**
     * Whether to allow reading environment variables. Defaults to false.
     */
    allowEnv?: boolean | string[];

    /**
     * Whether to allow running Deno plugins. Defaults to false.
     */
    allowPlugin?: boolean;

    /**
     * Whether to allow running subprocesses. Defaults to false.
     */
    allowRun?: boolean | string[];

    /**
     * Whether to allow high resolution time measurement. Defaults to false.
     */
    allowHrtime?: boolean;
  };

  /**
   * Options used to spawn the Deno child process
   */
  spawnOptions: SpawnOptions;
}

export const newDenoHTTPWorker = async (
  script: string | URL,
  options?: Partial<DenoWorkerOptions>
): Promise<DenoHTTPWorker> => {
  const _options = Object.assign(
    {
      denoExecutable: "deno",
      denoBootstrapScriptPath: DEFAULT_DENO_BOOTSTRAP_SCRIPT_PATH,
      reload: process.env.NODE_ENV !== "production",
      denoUnstable: false,
      location: undefined,
      permissions: {},
      denoV8Flags: [],
      denoImportMapPath: "",
      denoLockFilePath: "",
      denoCachedOnly: false,
      denoNoCheck: false,
      unsafelyIgnoreCertificateErrors: false,
      spawnOptions: {},
    },
    options || {}
  );

  let scriptArgs: string[];

  if (typeof script === "string") {
    scriptArgs = ["script", script];
  } else {
    scriptArgs = ["import", script.href];
  }

  let runArgs = [] as string[];

  // TODO: Let the host be user configurable?
  let allowAddress = "0.0.0.0:0";

  addOption(runArgs, "--reload", _options.reload);
  if (_options.denoUnstable === true) {
    runArgs.push("--unstable");
  } else if (_options.denoUnstable) {
    for (let [key] of Object.entries(_options.denoUnstable).filter(
      ([_key, val]) => val
    )) {
      runArgs.push(
        `--unstable-${key.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())}`
      );
    }
  }
  addOption(runArgs, "--cached-only", _options.denoCachedOnly);
  addOption(runArgs, "--no-check", _options.denoNoCheck);
  addOption(
    runArgs,
    "--unsafely-ignore-certificate-errors",
    _options.unsafelyIgnoreCertificateErrors
  );
  if (_options.location) {
    addOption(runArgs, "--location", [_options.location]);
  }

  if (_options.denoV8Flags.length > 0) {
    addOption(runArgs, "--v8-flags", _options.denoV8Flags);
  }

  if (_options.denoImportMapPath) {
    addOption(runArgs, "--import-map", [_options.denoImportMapPath]);
  }

  if (_options.denoLockFilePath) {
    addOption(runArgs, "--lock", [_options.denoLockFilePath]);
  }

  if (_options.permissions) {
    addOption(runArgs, "--allow-all", _options.permissions.allowAll);
    if (!_options.permissions.allowAll) {
      addOption(
        runArgs,
        "--allow-net",
        typeof _options.permissions.allowNet === "boolean"
          ? _options.permissions.allowNet
          : _options.permissions.allowNet
          ? [..._options.permissions.allowNet, allowAddress]
          : [allowAddress]
      );
      // Ensures the `allowAddress` isn't denied
      const deniedAddresses = _options.permissions.denyNet?.filter(
        (address) => address !== allowAddress
      );
      addOption(
        runArgs,
        "--deny-net",
        // Ensures an empty array isn't used
        deniedAddresses?.length ? deniedAddresses : false
      );
      addOption(runArgs, "--allow-read", _options.permissions.allowRead);
      addOption(runArgs, "--allow-write", _options.permissions.allowWrite);
      addOption(runArgs, "--allow-env", _options.permissions.allowEnv);
      addOption(runArgs, "--allow-plugin", _options.permissions.allowPlugin);
      addOption(runArgs, "--allow-hrtime", _options.permissions.allowHrtime);
    }
  }
  return new Promise((resolve, reject) => {
    const process = spawn(
      _options.denoExecutable,
      ["run", ...runArgs, _options.denoBootstrapScriptPath, ...scriptArgs],
      _options.spawnOptions
    );
    let running = false;
    let worker: DenoHTTPWorker;
    process.on("exit", (code: number, signal: string) => {
      if (!running) {
        reject(
          new Error(
            `Deno process exited before it was ready: code: ${code}, signal: ${signal}`
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
        console.error("http2 session error", err);
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

        worker = new DenoHTTPWorker(
          _httpSession,
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

class DenoHTTPWorker {
  private _httpSession: http2.ClientHttp2Session;
  private _got: Got;
  private _process: ChildProcess;
  private _stdout: Readable;
  private _stderr: Readable;
  private _terminated: Boolean = false;

  constructor(
    httpSession: http2.ClientHttp2Session,
    got: Got,
    process: ChildProcess,
    stdout: Readable,
    stderr: Readable
  ) {
    this._httpSession = httpSession;
    this._got = got;
    this._process = process;
    this._stdout = stdout;
    this._stderr = stderr;
  }

  get client(): Got {
    return this._got;
  }
  terminate(code?: number, signal?: string) {
    if (this._terminated) {
      return;
    }
    this.onexit(code || this._process.exitCode || 0, signal || "");
    this._terminated = true;
    if (this._process && this._process.exitCode === null) {
      // this._process.kill();
      forceKill(this._process.pid!);
    }
    this._httpSession.close();
  }

  get stdout() {
    return this._stdout;
  }

  get stderr() {
    return this._stderr;
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
