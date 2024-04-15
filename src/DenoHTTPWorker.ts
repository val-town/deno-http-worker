import path, { resolve } from "path";
import { ChildProcess, spawn, SpawnOptions, execSync } from "child_process";
import { Readable } from "stream";
import http2 from "http2";
const {
  HTTP2_HEADER_PATH,
  HTTP2_HEADER_METHOD,
  HTTP2_HEADER_HOST,
  HTTP2_HEADER_SCHEME,
  HTTP2_HEADER_STATUS,
} = http2.constants;
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
   * The path to the script that should be used to bootstrap the worker environment in Deno.
   * If specified, this script will be used instead of the default bootstrap script.
   * Only advanced users should set this.
   */
  denoBootstrapScriptPath: string;

  /**
   * Whether to reload scripts.
   * If given a list of strings then only the specified URLs will be reloaded.
   * Defaults to false when NODE_ENV is set to "production" and true otherwise.
   */
  reload: boolean | string[];

  /**
   * Whether to log stdout from the worker.
   * Defaults to true.
   */
  logStdout: boolean;

  /**
   * Whether to log stderr from the worker.
   * Defaults to true.
   */
  logStderr: boolean;

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
         *  Enable unstable 'bring your own node_modules' feature
         */
        byonm?: boolean;

        /**
         * Enable unstable resolving of specifiers by extension probing,
         * .js to .ts, and directory probing.
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
   * Allow Deno to make requests to hosts with certificate
   * errors.
   */
  unsafelyIgnoreCertificateErrors: boolean;

  /**
   * Specify the --location flag, which defines location.href.
   * This must be a valid URL if provided.
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
     * Whether to allow network connnections.
     * If given a list of strings then only the specified origins/paths are allowed.
     * Defaults to false.
     */
    allowNet?: boolean | string[];

    /**
     * Disable network access to provided IP addresses or hostnames. Any addresses
     * specified here will be denied access, even if they are specified in
     * `allowNet`. Note that deno-vm needs a network connection between the host
     * and the guest, so it's not possible to fully disable network access.
     */
    denyNet?: string[];

    /**
     * Whether to allow reading from the filesystem.
     * If given a list of strings then only the specified file paths are allowed.
     * Defaults to false.
     */
    allowRead?: boolean | string[];

    /**
     * Whether to allow writing to the filesystem.
     * If given a list of strings then only the specified file paths are allowed.
     * Defaults to false.
     */
    allowWrite?: boolean | string[];

    /**
     * Whether to allow reading environment variables.
     * Defaults to false.
     */
    allowEnv?: boolean | string[];

    /**
     * Whether to allow running Deno plugins.
     * Defaults to false.
     */
    allowPlugin?: boolean;

    /**
     * Whether to allow running subprocesses.
     * Defaults to false.
     */
    allowRun?: boolean | string[];

    /**
     * Whether to allow high resolution time measurement.
     * Defaults to false.
     */
    allowHrtime?: boolean;
  };

  /**
   * Options used to spawn the Deno child process
   */
  spawnOptions: SpawnOptions;
}

export class DenoHTTPWorker {
  private _httpSession?: http2.ClientHttp2Session;
  private _got?: Got;
  private _process: ChildProcess;
  private _options: DenoWorkerOptions;
  private _stdout: Readable;
  private _stderr: Readable;
  private _terminated: Boolean;
  private _ready: Boolean;
  private _pendingSessionRequests: {
    resolve: (value: http2.ClientHttp2Session) => void;
  }[];

  constructor(script: string | URL, options?: Partial<DenoWorkerOptions>) {
    this._ready = false;
    this._terminated = true;
    this._stdout = new Readable();
    this._stdout.setEncoding("utf-8");
    this._stderr = new Readable();
    this._stderr.setEncoding("utf-8");
    this._pendingSessionRequests = [];

    this._options = Object.assign(
      {
        denoExecutable: "deno",
        denoBootstrapScriptPath: DEFAULT_DENO_BOOTSTRAP_SCRIPT_PATH,
        reload: process.env.NODE_ENV !== "production",
        logStdout: true,
        logStderr: true,
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

    // TODO: Let this be user configurable?
    let allowAddress = "0.0.0.0:0";

    addOption(runArgs, "--reload", this._options.reload);
    if (this._options.denoUnstable === true) {
      runArgs.push("--unstable");
    } else if (this._options.denoUnstable) {
      for (let [key] of Object.entries(this._options.denoUnstable).filter(
        ([_key, val]) => val
      )) {
        runArgs.push(
          `--unstable-${key.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())}`
        );
      }
    }
    addOption(runArgs, "--cached-only", this._options.denoCachedOnly);
    addOption(runArgs, "--no-check", this._options.denoNoCheck);
    addOption(
      runArgs,
      "--unsafely-ignore-certificate-errors",
      this._options.unsafelyIgnoreCertificateErrors
    );
    if (this._options.location) {
      addOption(runArgs, "--location", [this._options.location]);
    }

    if (this._options.denoV8Flags.length > 0) {
      addOption(runArgs, "--v8-flags", this._options.denoV8Flags);
    }

    if (this._options.denoImportMapPath) {
      addOption(runArgs, "--import-map", [this._options.denoImportMapPath]);
    }

    if (this._options.denoLockFilePath) {
      addOption(runArgs, "--lock", [this._options.denoLockFilePath]);
    }

    if (this._options.permissions) {
      addOption(runArgs, "--allow-all", this._options.permissions.allowAll);
      if (!this._options.permissions.allowAll) {
        addOption(
          runArgs,
          "--allow-net",
          typeof this._options.permissions.allowNet === "boolean"
            ? this._options.permissions.allowNet
            : this._options.permissions.allowNet
            ? [...this._options.permissions.allowNet, allowAddress]
            : [allowAddress]
        );
        // Ensures the `allowAddress` isn't denied
        const deniedAddresses = this._options.permissions.denyNet?.filter(
          (address) => address !== allowAddress
        );
        addOption(
          runArgs,
          "--deny-net",
          // Ensures an empty array isn't used
          deniedAddresses?.length ? deniedAddresses : false
        );
        addOption(runArgs, "--allow-read", this._options.permissions.allowRead);
        addOption(
          runArgs,
          "--allow-write",
          this._options.permissions.allowWrite
        );
        addOption(runArgs, "--allow-env", this._options.permissions.allowEnv);
        addOption(
          runArgs,
          "--allow-plugin",
          this._options.permissions.allowPlugin
        );
        addOption(
          runArgs,
          "--allow-hrtime",
          this._options.permissions.allowHrtime
        );
      }
    }

    // TODO: remove
    console.log(
      "Spawn args:",
      this._options.denoExecutable,
      ["run", ...runArgs, this._options.denoBootstrapScriptPath, ...scriptArgs],
      this._options.spawnOptions
    );

    this._process = spawn(
      this._options.denoExecutable,
      ["run", ...runArgs, this._options.denoBootstrapScriptPath, ...scriptArgs],
      this._options.spawnOptions
    );
    this._process.on("exit", (code: number, signal: string) => {
      console.log("process exited");
    });

    this._stdout = <Readable>this._process.stdout;
    this._stderr = <Readable>this._process.stderr;

    if (this._options.logStdout) {
      this._stdout.setEncoding("utf-8");
      this._stdout.on("data", (data) => {
        // TODO: how to suppress this line from other stdout listeners?
        if (data.includes("deno-vm-port")) {
          const port = parseInt(data.split(" ")[1]);
          console.log("got port", port);
          if (!port) {
            this.terminate();
          }
          this._httpSession = http2.connect(`http://localhost:${port}`);
          this._httpSession.on("connect", (err) => {
            this._ready = true;
            this._pendingSessionRequests.forEach((req) => {
              req.resolve(this._httpSession!);
            });
          });
        }
        console.log("[deno]", data);
      });
    }
    if (this._options.logStderr) {
      this._stderr.setEncoding("utf-8");
      this._stderr.on("data", (data) => {
        console.log("[deno]", data);
      });
    }
  }

  async httpSession(): Promise<http2.ClientHttp2Session> {
    if (this._ready) {
      if (this._httpSession == undefined) {
        throw new Error(
          "DenoHTTPWorker is ready but the session does not exist"
        );
      }
      return this._httpSession;
    } else {
      return new Promise((resolve) => {
        this._pendingSessionRequests.push({ resolve });
      });
    }
  }
  async fetch(
    resource: string,
    options?: {
      body?: string | Buffer | ReadableStream;
      headers?: { [key: string]: string };
      method?: string;
    }
  ): Promise<Response> {
    return new Promise(async (resolve, reject) => {
      let u = new URL(resource);
      let session = await this.httpSession();

      if (options?.body instanceof ReadableStream) {
        options.headers = options.headers || {};
        options.headers["content-length"] = Buffer.byteLength(options.body);
        console.log("am writing");
      }

      let req = session.request({
        [HTTP2_HEADER_PATH]: u.pathname + u.search,
        [HTTP2_HEADER_METHOD]: options?.method || "GET",
        [HTTP2_HEADER_HOST]: u.host,
        [HTTP2_HEADER_SCHEME]: u.protocol.replace(":", ""),
      });

      if (options?.body instanceof ReadableStream) {
        let reader = options.body.getReader();
        new Promise((resolve) => {
          let read = () => {
            reader.read().then(({ done, value }) => {
              if (done) {
                resolve(undefined);
              } else {
                req.write(value);
                read();
              }
            });
          };
          read();
        });
      } else if (options?.body !== undefined) {
        req.write(options?.body);
      }

      const stream = new ReadableStream({
        start(controller) {
          req.on("data", (chunk) => {
            controller.enqueue(chunk);
          });
          req.on("end", () => {
            controller.close();
          });
        },
      });

      req.on("error", reject);
      req.on("response", (headers, flags) => {
        let _headers: [string, string][] = [];
        // We know htt2 will provide the status as a number
        let status = headers[HTTP2_HEADER_STATUS] as unknown as number;
        delete headers[HTTP2_HEADER_STATUS];
        for (let name in headers) {
          _headers.push([name, extractHeader(headers[name])]);
        }
        let resp = new Response(stream, { headers: _headers, status: status });

        resolve(resp);
      });
    });
  }
  terminate() {
    this._terminated = true;
    if (this._process && this._process.exitCode === null) {
      // this._process.kill();
      forceKill(this._process.pid!);
    }
    this._httpSession?.close();
  }

  private async _send(data: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (this._httpSession === undefined) {
        throw new Error("HTTP session not ready");
      }
      const req = this._httpSession.request({
        "X-DENO-VM-RPC": "1",
        [HTTP2_HEADER_PATH]: "/maxm",
        [HTTP2_HEADER_METHOD]: "POST",
        [HTTP2_HEADER_HOST]: "web.run.val.town",
        [HTTP2_HEADER_SCHEME]: "https",
      });
      req.write(JSON.stringify(data));
      req.on("response", (headers, flags) => {
        for (const name in headers) {
          console.log(`${name}: ${headers[name]}`);
        }
      });
      let responseData = "";
      req.on("data", (chunk) => {
        responseData += chunk;
      });
      req.on("end", () => {
        resolve(JSON.parse(responseData));
      });

      // const options = {
      //   hostname: "nghttp2.org",
      //   protocol: "https:",
      //   path: "/httpbin/post",
      //   method: "POST",
      //   headers: {
      //     "content-length": 6,
      //   },
      //   h2session: this._httpSession,
      // };
      // let request = http2.request(options, (response) => {
      //   const body = [];
      //   response.on("data", (chunk) => {
      //     body.push(chunk);
      //   });
      //   response.on("end", () => {
      //     resolve(Buffer.concat(body).toString());
      //   });
      // });
      // request.write(JSON.stringify(data));
      // this._got
      //   .post("http://web.run.val.town/maxm", {
      //     body: JSON.stringify(data),
      //     headers: { "X-Deno-VM-RPC": 1 },
      //   })
      //   .json()
      //   .then((data) => {
      //     resolve(data);
      //   });
    });
  }
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
  } catch (e) {
    // Allow this call to fail with
    // ESRCH, which meant that the process
    // to be killed was already dead.
    // But re-throw on other codes.
    if (e.code !== "ESRCH") {
      throw e;
    }
  }
}

function extractHeader(val: string | string[] | undefined): string {
  if (typeof val === "string") {
    return val;
  }
  if (val === undefined) {
    return "";
  }
  if (val.length == 0) {
    return "";
  }
  return val[val.length - 1]!;
}