import { it as _it, beforeAll, describe, expect, test } from "vitest";
import { type DenoHTTPWorker, newDenoHTTPWorker } from "./index.js";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { EarlyExitDenoHTTPWorkerError } from "./DenoHTTPWorker.js";

// Uncomment this if you want to debug serial test execution
// const it = _it.concurrent;
const it = _it;

const DEFAULT_HTTP_VAL = `export default async function (req: Request): Promise<Response> {
  return Response.json({ ok: true })
} `;

const jsonRequest = async (
  worker: DenoHTTPWorker,
  url: string,
  opts?: { headers?: { [key: string]: string }; body?: string }
): Promise<any> => {
  const resp = await worker.request({
    url,
    headers: new Headers(opts?.headers),
    body: opts?.body,
    method: "POST",
  });

  return resp.body.json();
};

test("EarlyExitDenoHTTPWorkerError", () => {
  expect(
    new EarlyExitDenoHTTPWorkerError("Test", "", "hi", 10, "SIGKILL")
  ).toHaveProperty("signal", "SIGKILL");
});

describe("DenoHTTPWorker", { timeout: 1000 }, () => {
  const echoFile = path.resolve(__dirname, "./test/echo-request.ts");
  const echoScript = fs.readFileSync(echoFile, { encoding: "utf-8" });
  const echoWebsocketFile = path.resolve(__dirname, "./test/echo-websocket.ts");
  const vtFile = path.resolve(__dirname, "./test/val-town.ts");
  const vtScript = fs.readFileSync(vtFile, { encoding: "utf-8" });

  beforeAll(() => {
    // Clean up sockets that might have been left around during terminated test
    // runs.
    fs.readdirSync(".").forEach((file) => {
      if (path.basename(file).endsWith("-deno-http.sock")) {
        fs.rmSync(file);
      }
    });
  });
  it("onSpawn is called", async () => {
    let pid: number | undefined;
    const worker = await newDenoHTTPWorker(
      `
        export default { async fetch (req: Request): Promise<Response> {
          let headers = {};
          for (let [key, value] of req.headers.entries()) {
            headers[key] = value;
          }
          return Response.json({ ok: req.url, headers: headers })
        } }
      `,
      {
        onSpawn: (process) => {
          pid = process.pid;
        },
      }
    );
    expect(pid).toBeDefined();
    await worker.terminate();
  });

  it("don't crash on socket removal", async () => {
    const worker = await newDenoHTTPWorker(
      `
        export default { async fetch (req: Request): Promise<Response> {
          await Deno.removeSync(Deno.args[0]);
          return Response.json({ ok: req.url })
        } }
      `,
      { printOutput: false }
    );
    const json = await jsonRequest(worker, "https://localhost/hello?isee=you", {
      headers: { accept: "application/json" },
    });
    expect(json).toEqual({
      ok: "https://localhost/hello?isee=you",
    });
    await worker.terminate();
  });

  it("json response multiple requests", async () => {
    const worker = await newDenoHTTPWorker(
      `
        export default { async fetch (req: Request): Promise<Response> {
          let headers = {};
          for (let [key, value] of req.headers.entries()) {
            headers[key] = value;
          }
          return Response.json({ ok: req.url, headers: headers })
        } }
      `,
      { printOutput: false }
    );
    for (let i = 0; i < 10; i++) {
      const json = await jsonRequest(
        worker,
        "https://localhost/hello?isee=you",
        { headers: { accept: "application/json" } }
      );
      expect(json).toEqual({
        ok: "https://localhost/hello?isee=you",
        headers: { accept: "application/json", "content-length": "0" }, // undici adds content-length
      });
    }
    await worker.terminate();
  });

  it("onError", async () => {
    const worker = await newDenoHTTPWorker(
      `
        export default { async fetch (req: Request): Promise<Response> {
          return {} // not a response
        }, onError (error: Error): Response {
          return Response.json({ error: error.message }, { status: 500 })
        }}
      `,
      { printOutput: false }
    );
    const json = await jsonRequest(worker, "https://localhost/hello?isee=you", {
      headers: { accept: "application/json" },
    });
    expect(json).toEqual({
      error:
        "Return value from serve handler must be a response or a promise resolving to a response",
    });

    await worker.terminate();
  });
  it("onError not handled", { timeout: 20_000 }, async () => {
    // onError is not called in all cases, for example, here I can pass a
    // readable stream and the error is only caught by the global onerror handler.
    const worker = await newDenoHTTPWorker(
      `
        export default { async fetch (req: Request): Promise<Response> {
          setTimeout(() => {
            throw new Error("uncaught!")
          })
          return Response.json(null)
        }, onError (error: Error): Response {
          return Response.json({ error: error.message }, { status: 500 })
        }}
      `,
      { printOutput: false }
    );
    jsonRequest(worker, "https://localhost/hello?isee=you", {
      headers: { accept: "application/json" },
    }).catch(() => {});

    for (;;) {
      const stderr = worker.stderr.read();
      if (stderr) {
        expect(stderr.toString()).toContain("Error: uncaught!");
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await worker.terminate();
  });

  it("unhandled rejection", async () => {
    // the process **does** die for unhandled rejections
    const worker = await newDenoHTTPWorker(
      `
        export default { async fetch (req: Request): Promise<Response> {
          Promise.reject(new Error("uncaught!"))
          return Response.json(null)
        }, onError (error: Error): Response {
          return Response.json({ error: error.message }, { status: 500 })
        }}
      `,
      { printOutput: false }
    );
    const codePromise = new Promise((res) => {
      worker.addListener("exit", (code) => res(code));
    });

    jsonRequest(worker, "https://localhost/hello?isee=you", {
      headers: { accept: "application/json" },
    }).catch(() => {});

    expect(await codePromise).toEqual(1);
    await worker.terminate();
  });

  it("shutdown gracefully", async () => {
    const worker = await newDenoHTTPWorker(
      `
        export default { async fetch (req: Request): Promise<Response> {
          new Promise((resolve) => setTimeout(() => {resolve(); console.log("hi")}, 200));
          return Response.json({ ok: req.url })
        }}
      `,
      { printOutput: false }
    );

    let logs = "";
    worker.stderr.on("data", (data) => (logs += data));
    worker.stdout.on("data", (data) => (logs += data));

    const exitPromise = new Promise<void>((resolve) => {
      worker.addListener("exit", (code) => {
        expect(code).toEqual(0);
        expect(logs).toContain("hi");
        resolve();
      });
    });
    const json = await jsonRequest(worker, "https://localhost/hello?isee=you");
    expect(json).toEqual({
      ok: "https://localhost/hello?isee=you",
    });
    void worker.shutdown();
    await exitPromise;
  });

  describe("runFlags editing", () => {
    it.each([
      "--allow-read",
      "--allow-write",
      "--allow-read=/dev/null",
      "--allow-write=/dev/null",
      "--allow-read=foo,/dev/null",
      "--allow-write=bar,/dev/null",
    ])("should handle %s", async (flag) => {
      const worker = await newDenoHTTPWorker(echoScript, {
        printOutput: false,
        runFlags: [flag],
      });
      await jsonRequest(worker, "http://localhost");
      await worker.terminate();
    });
  });

  it("should be able to import script (and call terminate multiple times without incident)", async () => {
    const file = path.resolve(__dirname, "./test/echo-request.ts");
    const url = new URL(`file://${file}`);
    const worker = await newDenoHTTPWorker(url, {
      printOutput: false,
      printCommandAndArguments: false,
    });

    await jsonRequest(worker, "http://localhost");
    await worker.terminate();
    await worker.terminate();
    await worker.terminate();
    await worker.terminate();
  });

  it("host and connection is not overwritten", async () => {
    const worker = await newDenoHTTPWorker(echoScript, {
      printOutput: false,
    });
    const resp: any = await jsonRequest(worker, "https://localhost/", {
      headers: {
        connection: "keep-alive",
        host: "bear.example.com",
        "x-foo-bar": "buzz",
      },
    });
    expect(resp.headers.connection).toEqual("keep-alive");
    expect(resp.headers.host).toEqual("bear.example.com");
    expect(resp.headers["x-foo-bar"]).toEqual("buzz");
    await worker.terminate();
  });

  it("host and connection cannot be set by user", async () => {
    const worker = await newDenoHTTPWorker(echoScript);
    const resp: any = await jsonRequest(worker, "https://localhost/", {
      headers: {
        connection: "keep-alive",
        host: "bear.example.com",
        "x-deno-worker-host": "should-not-be-able-to-set",
      },
    });
    expect(resp.headers["x-deno-worker-host"]).toBeUndefined();
    await worker.terminate();
  });

  it("use http directly", async () => {
    const worker = await newDenoHTTPWorker(echoScript, { printOutput: true });

    await new Promise((resolve) => setTimeout(resolve, 300));

    const resp = await worker.request({
      url: "http://localhost/hi",
      method: "GET",
    });
    const json = await resp.body.json();

    expect(json).toEqual({
      url: "http://localhost/hi",
      headers: {},
      body: "",
      method: "GET",
    });
    await worker.terminate();
  });

  it("can implement val town with http.request", async () => {
    const worker = await newDenoHTTPWorker(vtScript, { printOutput: true });

    await worker.request({
      url: "http://vt/",
      method: "POST",
      headers: new Headers({
        "Content-Type": "application/json",
      }),
      body: `data:text/tsx,${encodeURIComponent(DEFAULT_HTTP_VAL)}`,
    });

    const text = await worker
      .request({
        url: "http://vt/",
        method: "GET",
      })
      .then((resp) => resp.body.text());

    expect(text).toEqual('{"ok":true}');
    // await initReq;
    await worker.terminate();
  });

  it("can test that snippets in readme run successfully", async () => {
    const rm = fs.readFileSync(path.resolve(__dirname, "../README.md"), {
      encoding: "utf-8",
    });

    const toTest = rm
      .split("\n```")
      .filter((line) => line.startsWith("ts\n"))
      .map((line) => line.slice(3));
    for (let source of toTest) {
      const replacedSource = source.replaceAll(
        'import { newDenoHTTPWorker } from "@valtown/deno-http-worker";',
        "const { newDenoHTTPWorker } = await import('./dist/index.js');          "
      );
      if (replacedSource === source) {
        throw new Error(
          "No replacement found in readme, do you need to update the replacement string?"
        );
      }
      source = `(async () => {${replacedSource}})()`;

      await new Promise<void>((resolve, reject) => {
        const worker = new Worker(source, {
          eval: true,
        });
        worker.stderr.on("data", () => {
          // console.error(data.toString());
        });
        worker.stdout.on("data", () => {
          // console.error(data.toString());
        });
        worker.on("error", (e) => {
          reject(e);
        });
        worker.on("exit", () => {
          resolve();
        });
      });
    }
  });

  it("can upgrade websocket", async () => {
    const webSocketScriptStr = fs.readFileSync(echoWebsocketFile, {
      encoding: "utf-8",
    });
    const worker = await newDenoHTTPWorker(webSocketScriptStr, {
      printOutput: false,
    });

    const messages: string[] = [];
    const ws = await worker.websocket("ws://localhost/echo");
    const event = await new Promise<Event>((res) => {
      ws.addEventListener("open", (event) => {
        ws.send("message1");
        res(event);
      });
      ws.addEventListener("message", (event) => {
        messages.push(event.data);
      });
      ws.addEventListener("close", (event) => {
        expect(event.code).toEqual(4001);
        expect(event.reason).toEqual("bye");
        res(event);
      });
    });
    expect(event.type).toEqual("open");

    ws.send("message2");
    ws.send("message3");

    await new Promise((res) => setTimeout(res, 50));

    expect(messages).toEqual(["message1", "message2", "message3"]);

    ws.close(4001, "bye");
    await new Promise((res) => ws.addEventListener("close", res));

    await worker.terminate();
  });

  it("can upgrade many websockets at the same time, and identify them uniquely", async () => {
    const webSocketScriptStr = fs.readFileSync(echoWebsocketFile, {
      encoding: "utf-8",
    });
    const worker = await newDenoHTTPWorker(webSocketScriptStr, {
      printOutput: false,
    });

    const ws1 = await worker.websocket("ws://localhost/echo");
    const ws2 = await worker.websocket("ws://localhost/echo");

    await new Promise<void>((res) => {
      ws1.addEventListener("open", () => res());
    });
    await new Promise<void>((res) => {
      ws2.addEventListener("open", () => res());
    });

    const ws1Messages: string[] = [];
    const ws2Messages: string[] = [];

    ws1.addEventListener("message", (event) => {
      ws1Messages.push(event.data);
    });
    ws2.addEventListener("message", (event) => {
      ws2Messages.push(event.data);
    });

    // Now we send 50 messages to each and make sure that they receive the correct ones
    for (let i = 0; i < 50; i++) {
      ws1.send(`ws1-message-${i}`);
      ws2.send(`ws2-message-${i}`);
    }

    await new Promise((res) => setTimeout(res, 50));

    expect(ws1Messages).toEqual(
      Array.from({ length: 50 }, (_, i) => `ws1-message-${i}`)
    );
    expect(ws2Messages).toEqual(
      Array.from({ length: 50 }, (_, i) => `ws2-message-${i}`)
    );

    await worker.terminate();
  });
});
