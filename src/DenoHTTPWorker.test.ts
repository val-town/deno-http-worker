import { it, describe, expect } from "vitest";
import { newDenoHTTPWorker } from "./index.js";

describe("DenoHTTPWorker", { timeout: 1000 }, () => {
  it("json response", async () => {
    let worker = await newDenoHTTPWorker(`
        export default async function (req: Request): Promise<Response> {
          let headers = {};
          for (let [key, value] of req.headers.entries()) {
            headers[key] = value;
          }
          return Response.json({ ok: req.url, headers: headers })
        }
      `);

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
});
