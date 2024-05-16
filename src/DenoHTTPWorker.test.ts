import { it as _it, beforeAll, describe, expect } from "vitest";
import { DenoHTTPWorker, newDenoHTTPWorker } from "./index.js";
import fs from "fs";
import path from "path";

// Uncomment this if you want to debug serial test execution
// const it = _it.concurrent;
const it = _it;

const DEFAULT_HTTP_VAL = `export default async function (req: Request): Promise<Response> {
  return Response.json({ ok: true })
} `;

const jsonRequest = (
  worker: DenoHTTPWorker,
  url: string,
  opts?: { headers?: { [key: string]: string }; body?: string }
): Promise<any> => {
  return new Promise((resolve, reject) => {
    let req = worker.request(url, opts || {}, (resp) => {
      const body: any[] = [];
      resp.on("error", reject);
      resp.on("data", (chunk) => {
        body.push(chunk);
      });
      resp.on("end", () => {
        resolve(JSON.parse(Buffer.concat(body).toString()));
      });
    });
    req.on("error", reject);
    req.end();
  });
};

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
      let json = await jsonRequest(worker, "https://localhost/hello?isee=you", {
        headers: { accept: "application/json" },
      });
      expect(json).toEqual({
        ok: "https://localhost/hello?isee=you",
        headers: { accept: "application/json" },
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
      let json = await jsonRequest(worker, "https://localhost/hello?isee=you");
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
      await jsonRequest(worker, "http://localhost");
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

    await jsonRequest(worker, "http://localhost");
    await worker.terminate();
  });

  it("host and connection is not overwritten", async () => {
    let worker = await newDenoHTTPWorker(echoScript, {
      printOutput: true,
    });
    let resp: any = await jsonRequest(worker, "https://localhost/", {
      headers: { connection: "happy", host: "fish" },
    });
    expect(resp["headers"]["connection"]).toEqual("happy");
    expect(resp["headers"]["host"]).toEqual("fish");
    await worker.terminate();
  });

  // it("json response", async () => {
  //   let worker = await newDenoHTTPWorker(echoScript);

  //   const t0 = performance.now();
  //   let resp = (await worker.client
  //     .post("https://localhost/", { json: { ok: true } })
  //     .json()) as any;
  //   expect(resp.body).toEqual('{"ok":true}');
  //   console.log("Got time", performance.now() - t0);

  //   // TODO: test against streaming resp as well as request body
  //   let req = worker.client.post("https://localhost/", {
  //     body: fs.createReadStream(import.meta.url.replace("file://", "")),
  //   });

  //   let body: any = await req.json();
  //   expect(body.body).toEqual(
  //     fs.readFileSync(import.meta.url.replace("file://", "")).toString()
  //   );

  //   worker.terminate();
  // });

  it("use http directly", async () => {
    let worker = await newDenoHTTPWorker(echoScript, { printOutput: true });

    await new Promise((resolve) => setTimeout(resolve, 300));

    const t0 = performance.now();
    let json = await new Promise((resolve) => {
      let req = worker.request("http://localhost/hi", {}, (resp) => {
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
      headers: {},
      body: "",
      method: "GET",
    });
    worker.terminate();
  });

  // it("post with body", async () => {
  //   let worker = await newDenoHTTPWorker(`
  //       export default async function (req: Request): Promise<Response> {
  //         let body = await req.text();
  //         return Response.json({ length: body.length })
  //       }
  //     `);

  //   let resp = worker.client("https://localhost:8080/", {
  //     body: "hello",
  //     method: "POST",
  //   });
  //   expect(await resp.json()).toEqual({ length: 5 });
  //   worker.terminate();
  // });

  // it("can implement val town", async () => {
  //   let worker = await newDenoHTTPWorker(vtScript, { printOutput: true });

  //   const t0 = performance.now();
  //   let first = worker.client.post("https://localhost:8080/", {
  //     body: "data:text/tsx," + encodeURIComponent(DEFAULT_HTTP_VAL),
  //   });
  //   // We send a request to initialize and when the first request is in flight
  //   // we send another request
  //   let second = worker.client("https://foo.web.val.run");

  //   expect((await first).statusCode).toEqual(200);
  //   expect(await first.text()).toEqual("vt-done");
  //   expect(await second.text()).toEqual('{"ok":true}');
  //   console.log("double request got val: ", performance.now() - t0);
  //   worker.terminate();
  // });

  it("can implement val town with http.request", async () => {
    let worker = await newDenoHTTPWorker(vtScript, { printOutput: true });

    const t0 = performance.now();
    await new Promise((resolve, reject) => {
      const req = worker.request(
        "http://vt",
        {
          headers: {
            "Content-Type": "application/json",
          },
          method: "POST",
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
      req.on("error", reject);
      req.write(`data:text/tsx,${encodeURIComponent(DEFAULT_HTTP_VAL)}`);
      req.end();
    });

    let text = await new Promise((resolve) => {
      let req = worker.request(
        "https://localhost:1234",
        { headers: {} },
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
  // it("val town import header", async () => {
  //   let worker = await newDenoHTTPWorker(vtHeaderScript, { printOutput: true });

  //   const t0 = performance.now();
  //   let text = await new Promise((resolve) => {
  //     let req = worker.request(
  //       "https://localhost:1234",
  //       {
  //         headers: {
  //           "X-VT-Import": `data:text/tsx,${encodeURIComponent(
  //             DEFAULT_HTTP_VAL
  //           )}`,
  //         },
  //       },
  //       (resp) => {
  //         const body: any[] = [];
  //         resp.on("data", (chunk) => {
  //           body.push(chunk);
  //         });
  //         resp.on("end", () => {
  //           resolve(Buffer.concat(body).toString());
  //         });
  //       }
  //     );
  //     req.end();
  //   });
  //   expect(text).toEqual('{"ok":true}');
  //   console.log("single request:", performance.now() - t0);
  //   // await initReq;
  //   worker.terminate();
  // });
});
