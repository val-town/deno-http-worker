import { it as _it, beforeAll, describe, expect } from "vitest";
import { newDenoHTTPWorker } from "./index.js";
import fs from "fs";
import path from "path";
import http2 from "http2-wrapper";

// Uncomment this if you want to debug serial test execution
// const it = _it.concurrent;
const it = _it;

const DEFAULT_HTTP_VAL = `export default async function (req: Request): Promise<Response> {
  return Response.json({ ok: true })
} `;

describe("DenoHTTPWorker", { timeout: 1000 }, () => {
  const echoFile = path.resolve(__dirname, "./test/echo-request.ts");
  const echoScript = fs.readFileSync(echoFile, { encoding: "utf-8" });
  const vtFile = path.resolve(__dirname, "./test/val-town.ts");
  const vtScript = fs.readFileSync(vtFile, { encoding: "utf-8" });
  const vtHeaderFile = path.resolve(__dirname, "./test/val-town-header.ts");
  const vtHeaderScript = fs.readFileSync(vtHeaderFile, { encoding: "utf-8" });

  beforeAll(() => {
    // Clean up sockets that might have been left around during terminated test
    // runs.
    fs.readdirSync(".").forEach((file) => {
      if (path.basename(file).endsWith("-deno-http.sock")) {
        fs.rmSync(file);
      }
    });
  });
  it("json response multiple requests", async () => {
    let worker = await newDenoHTTPWorker(
      `
        export default async function (req: Request): Promise<Response> {
          let headers = {};
          for (let [key, value] of req.headers.entries()) {
            headers[key] = value;
          }
          return Response.json({ ok: req.url, headers: headers })
        }
      `,
      { printOutput: true }
    );
    for (let i = 0; i < 10; i++) {
      let json = await worker.client
        .get("https://localhost/hello?isee=you", { headers: {} })
        .json();
      expect(json).toEqual({
        ok: "https://localhost/hello?isee=you",
        headers: {
          accept: "application/json",
          "accept-encoding": "gzip, deflate, br",
        },
      });
    }
    worker.terminate();
  });

  it("shutdown gracefully", async () => {
    let worker = await newDenoHTTPWorker(
      `
        export default async function (req: Request): Promise<Response> {
          new Promise((resolve) => setTimeout(() => {resolve(); console.log("hi")}, 200));
          return Response.json({ ok: req.url })
        }
      `,
      { printOutput: true }
    );

    let logs = "";
    worker.stderr.on("data", (data) => (logs += data));
    worker.stdout.on("data", (data) => (logs += data));

    await new Promise<void>(async (resolve) => {
      worker.addEventListener("exit", (code, signal) => {
        expect(code).toEqual(0);
        expect(logs).toContain("hi");
        resolve();
      });
      let json = await worker.client
        .get("https://localhost/hello?isee=you", { headers: {} })
        .json();
      expect(json).toEqual({
        ok: "https://localhost/hello?isee=you",
      });
      worker.shutdown();
    });
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
      let worker = await newDenoHTTPWorker(echoScript, {
        printOutput: true,
        runFlags: [flag],
      });
      await worker.client.get("https://localhost/").json();
      await worker.terminate();
    });
  });

  it("should be able to import script", async () => {
    const file = path.resolve(__dirname, "./test/echo-request.ts");
    const url = new URL(`file://${file}`);
    let worker = await newDenoHTTPWorker(url, {
      printOutput: true,
      printCommandAndArguments: true,
    });

    let resp: any = await worker.client
      .get("https://localhost/", {
        headers: { "User-Agent": "some value" },
      })
      .json();
    await worker.terminate();
  });

  it("user agent is not overwritten", async () => {
    let worker = await newDenoHTTPWorker(echoScript, {
      printOutput: true,
    });
    let resp: any = await worker.client
      .get("https://localhost/", {
        headers: { "User-Agent": "some value" },
      })
      .json();
    expect(resp["headers"]["user-agent"]).toEqual("some value");
    await worker.terminate();
  });

  it("json response", async () => {
    let worker = await newDenoHTTPWorker(echoScript);

    const t0 = performance.now();
    let resp = (await worker.client
      .post("https://localhost/", { json: { ok: true } })
      .json()) as any;
    expect(resp.body).toEqual('{"ok":true}');
    console.log("Got time", performance.now() - t0);

    // TODO: test against streaming resp as well as request body
    let req = worker.client.post("https://localhost/", {
      body: fs.createReadStream(import.meta.url.replace("file://", "")),
    });

    let body: any = await req.json();
    expect(body.body).toEqual(
      fs.readFileSync(import.meta.url.replace("file://", "")).toString()
    );

    worker.terminate();
  });

  it("use http2 directly", async () => {
    let worker = await newDenoHTTPWorker(echoScript, { printOutput: true });
    const t0 = performance.now();
    let json = await new Promise((resolve) => {
      let req = worker.request("https://localhost/hi", {}, (resp) => {
        const body: any[] = [];
        resp.on("data", (chunk) => {
          body.push(chunk);
        });
        resp.on("end", () => {
          resolve(JSON.parse(Buffer.concat(body).toString()));
        });
      });
      req.end();
    });
    console.log("http2 request time", performance.now() - t0);
    expect(json).toEqual({
      url: "https://localhost/hi",
      headers: {},
      body: "",
      method: "GET",
    });
    worker.terminate();
  });
  it("use http directly", async () => {
    let worker = await newDenoHTTPWorker(echoScript, { printOutput: true });

    await new Promise((resolve) => setTimeout(resolve, 300));

    for (let i = 0; i < 2; i++) {
      const t0 = performance.now();
      let json = await new Promise((resolve) => {
        let req = worker.httpRequest("http://localhost/hi", {}, (resp) => {
          const body: any[] = [];
          resp.on("data", (chunk) => {
            body.push(chunk);
          });
          resp.on("end", () => {
            resolve(JSON.parse(Buffer.concat(body).toString()));
          });
        });
        req.end();
      });
      console.log("http request time", performance.now() - t0);
      expect(json).toEqual({
        url: "http://localhost/hi",
        headers: { connection: "keep-alive", host: "localhost" },
        body: "",
        method: "GET",
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    worker.terminate();
  });

  it("post with body", async () => {
    let worker = await newDenoHTTPWorker(`
        export default async function (req: Request): Promise<Response> {
          let body = await req.text();
          return Response.json({ length: body.length })
        }
      `);

    let resp = worker.client("https://localhost:8080/", {
      body: "hello",
      method: "POST",
    });
    expect(await resp.json()).toEqual({ length: 5 });
    worker.terminate();
  });

  it("can implement val town", async () => {
    let worker = await newDenoHTTPWorker(vtScript, { printOutput: true });

    const t0 = performance.now();
    let first = worker.client.post("https://localhost:8080/", {
      body: "data:text/tsx," + encodeURIComponent(DEFAULT_HTTP_VAL),
    });
    // We send a request to initialize and when the first request is in flight
    // we send another request
    let second = worker.client("https://foo.web.val.run");

    expect((await first).statusCode).toEqual(200);
    expect(await first.text()).toEqual("vt-done");
    expect(await second.text()).toEqual('{"ok":true}');
    console.log("double request got val: ", performance.now() - t0);
    worker.terminate();
  });

  it("can implement val town with http2.request", async () => {
    let worker = await newDenoHTTPWorker(vtScript, { printOutput: true });

    const t0 = performance.now();
    let initReq = new Promise((resolve) => {
      const req = worker.request(
        "http://vt",
        {
          headers: {
            "Content-Type": "application/json",
          },
          method: "POST",
        },
        (resp) => {
          resolve(resp);
        }
      );
      req.on("error", console.error);
      req.write(`data:text/tsx,${encodeURIComponent(DEFAULT_HTTP_VAL)}`);
      req.end();
    });
    let text = await new Promise((resolve) => {
      let req = worker.request(
        "https://localhost:1234",
        { headers: { connection: "upgrade" } },
        (resp) => {
          const body: any[] = [];
          resp.on("data", (chunk) => {
            body.push(chunk);
          });
          resp.on("end", () => {
            resolve(Buffer.concat(body).toString());
          });
        }
      );
      req.end();
    });
    expect(text).toEqual('{"ok":true}');
    console.log("Double request http2 val:", performance.now() - t0);
    // await initReq;
    worker.terminate();
  });
  it("val town import header", async () => {
    let worker = await newDenoHTTPWorker(vtHeaderScript, { printOutput: true });

    const t0 = performance.now();
    let text = await new Promise((resolve) => {
      let req = worker.request(
        "https://localhost:1234",
        {
          headers: {
            "X-VT-Import": `data:text/tsx,${encodeURIComponent(
              DEFAULT_HTTP_VAL
            )}`,
          },
        },
        (resp) => {
          const body: any[] = [];
          resp.on("data", (chunk) => {
            body.push(chunk);
          });
          resp.on("end", () => {
            resolve(Buffer.concat(body).toString());
          });
        }
      );
      req.end();
    });
    expect(text).toEqual('{"ok":true}');
    console.log("single request:", performance.now() - t0);
    // await initReq;
    worker.terminate();
  });
});
