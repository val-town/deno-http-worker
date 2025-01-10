import path, { resolve } from "node:path";
import { spawn, SpawnOptions } from "node:child_process";
import { Readable } from "node:stream";
import readline from "node:readline";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";

import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_DENO_BOOTSTRAP_SCRIPT_PATH = resolve(
	__dirname,
	"../deno-bootstrap/index.ts",
);

interface OnExitListener {
	(exitCode: number, signal: string): void;
}

export class EarlyExitDenoHTTPWorkerError extends Error {
	constructor(
		public message: string,
		public stderr: string,
		public stdout: string,
		public code: number,
		public signal: string,
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
		listener: (code: number | null, signal: NodeJS.Signals | null) => void,
	): this;
	on(event: "disconnect", listener: () => void): this;
	on(event: "error", listener: (err: Error) => void): this;
	on(
		event: "exit",
		listener: (code: number | null, signal: NodeJS.Signals | null) => void,
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
		options: SpawnOptions,
	) => MinimalChildProcess;
}

/**
 * Create a new DenoHTTPWorker. This function will start a worker and being
 */
export const newDenoHTTPWorker = async (
	script: string | URL,
	options: Partial<DenoWorkerOptions> = {},
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

	// Create the socket location that we'll use to communicate with Deno.
	const socketFile = path.join(
		os.tmpdir(),
		`${crypto.randomUUID()}-deno-http.sock`,
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

			const process = _options.spawnFunc(command, args, _options.spawnOptions);
			let running = false;
			let exited = false;
			let worker: DenoHTTPWorker | undefined = undefined;
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
							signal,
						),
					);
					fs.rm(socketFile).catch(() => {});
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

			// Wait for the socket file to be created by the Deno process.
			for (;;) {
				if (exited) {
					break;
				}
				try {
					await fs.stat(socketFile);
					// File exists
					break;
				} catch (err) {
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
		callback: (response: http.IncomingMessage) => void,
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
	#terminated: Boolean = false;
	#agent: http.Agent;

	constructor(
		socketFile: string,
		process: MinimalChildProcess,
		stdout: Readable,
		stderr: Readable,
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
		fs.rm(this.#socketFile).catch(() => {});
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
		callback: (response: http.IncomingMessage) => void,
	): http.ClientRequest {
		options.headers = options.headers || {};

		// TODO: ensure these are handled with the correct casing?
		delete options.headers["x-deno-worker-host"];
		delete options.headers["x-deno-worker-connection"];

		// NodeJS will send both the host and the connection headers
		// (https://nodejs.org/api/http.html#new-agentoptions). We don't want these
		// to make it to Deno unless they are explicitly set by the user. So store
		// them to reconstruct on the other size.
		if (options.headers.host)
			options.headers["X-Deno-Worker-Host"] = options.headers.host;
		if (options.headers.connection)
			options.headers["X-Deno-Worker-Connection"] = options.headers.connection;

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
				},
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

	addEventListener(type: "exit", listener: OnExitListener): void {
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
