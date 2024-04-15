import { it, describe, expect } from "vitest";
import { DenoHTTPWorker } from "./index.js";

describe("DenoHTTPWorker", () => {
  it("json response", async () => {
    let worker = new DenoHTTPWorker(`
        export default async function (req: Request): Promise<Response> {
          let headers = {};
          for (let [key, value] of req.headers.entries()) {
            headers[key] = value;
          }
          return Response.json({ ok: req.url, headers: headers })
        }
      `);

    let got = await worker.getClient();
    let json = await got.get("https://localhost/", { headers: {} }).json();
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
    let worker = new DenoHTTPWorker(`
        export default async function (req: Request): Promise<Response> {
          console.log(req.body)
          let body = await req.text();
          return Response.json({ length: body.length })
        }
      `);

    let got = await worker.getClient();

    let resp = got("https://localhost:8080/", {
      body: "hello",
      method: "POST",
    });
    expect(await resp.json()).toEqual({ length: 5 });

    worker.terminate();
  });
});
