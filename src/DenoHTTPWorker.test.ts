import { it as _it, describe, expect } from "vitest";
import { newDenoHTTPWorker } from "./index.js";
import fs from "fs";
import path from "path";

// Uncomment this if you want to debug serial test execution
const it = _it.concurrent;
// const it = _it

describe("DenoHTTPWorker", { timeout: 1000 }, () => {
  const echoFile = path.resolve(__dirname, "./test/echo-request.ts");
  const echoScript = fs.readFileSync(echoFile, { encoding: "utf-8" });
  const vtFile = path.resolve(__dirname, "./test/val-town.ts");
  const vtScript = fs.readFileSync(vtFile, { encoding: "utf-8" });

  it("json response multiple requests", async () => {
    let worker = await newDenoHTTPWorker(`
        export default async function (req: Request): Promise<Response> {
          let headers = {};
          for (let [key, value] of req.headers.entries()) {
            headers[key] = value;
          }
          return Response.json({ ok: req.url, headers: headers })
        }
      `);
    for (let i = 0; i < 10; i++) {
      let json = await worker.client
        .get("https://localhost/", { headers: {} })
        .json();
      expect(json).toEqual({
        ok: "https://localhost/",
        headers: {
          accept: "application/json",
          "accept-encoding": "gzip, deflate, br",
        },
      });
    }
    worker.terminate();
  });

  it("deny-net not always allowed", async () => {
    expect(
      newDenoHTTPWorker(echoScript, {
        runFlags: [`--deny-net`],
        printOutput: true,
      })
    ).rejects.toThrowError("not supported");
    expect(
      newDenoHTTPWorker(echoScript, {
        runFlags: [`--deny-net=0.0.0.0:0`],
        printOutput: true,
      })
    ).rejects.toThrowError("with the address");
  });

  it("should be able to import script", async () => {
    const file = path.resolve(__dirname, "./test/echo-request.ts");
    const url = new URL(`file://${file}`);
    let worker = await newDenoHTTPWorker(url, {
      runFlags: [`--allow-read=${file}`],
      printOutput: true,
    });

    let resp: any = await worker.client
      .get("https://localhost/", {
        headers: { "User-Agent": "some value" },
      })
      .json();
    await worker.terminate();
  });

  it("user agent is not overwritten", async () => {
    let worker = await newDenoHTTPWorker(echoScript);
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
    let resp = (await worker.client
      .post("https://localhost/", { json: { ok: true } })
      .json()) as any;
    expect(resp.body).toEqual('{"ok":true}');

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

  it("port log is not in output", async () => {
    let worker = await newDenoHTTPWorker(
      `console.log("Hi, I am here");
    export default async function (req: Request): Promise<Response> {
      let body = await req.text();
      return Response.json({ length: body.length })
    }`
    );
    let allStdout = "";

    worker.stdout.on("data", (data) => {
      allStdout += data;
    });

    await worker.client("https://hey.ho").text();
    worker.terminate();

    expect(allStdout).toEqual("Hi, I am here\n");
  });

  it("cannot make outside connection to deno server", async () => {
    let worker = await newDenoHTTPWorker(
      `export default async function (req: Request): Promise<Response> {
      let body = await req.text();
      return Response.json({ length: body.length })
    }`
    );

    await expect(
      fetch("http://localhost:" + worker.denoListeningPort)
    ).rejects.toThrowError("fetch failed");

    worker.terminate();
  });

  it("can implement val town", async () => {
    let worker = await newDenoHTTPWorker(vtScript, { printOutput: true });

    let first = worker.client.post("https://localhost:8080/", {
      body:
        "data:text/tsx," +
        encodeURIComponent(`export default async function (req: Request): Promise<Response> {
      return Response.json({ ok: true })
    } ${"///".repeat(8000)}`),
    });
    // We send a request to initialize and when the first request is in flight
    // we send another request
    let second = worker.client("https://foo.web.val.run");

    await first.text();
    expect(await second.text()).toEqual('{"ok":true}');

    worker.terminate();
  });
});
