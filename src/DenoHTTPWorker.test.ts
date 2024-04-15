import { beforeAll, it, describe, expect } from "vitest";
import { DenoHTTPWorker } from "./index.js";
import http2 from "http2-wrapper";
const {
  HTTP2_HEADER_PATH,
  HTTP2_HEADER_METHOD,
  HTTP2_HEADER_HOST,
  HTTP2_HEADER_SCHEME,
} = http2.constants;

describe("DenoHTTPWorker", () => {
  it("json response", async () => {
    let worker = new DenoHTTPWorker(`
        export default async function (req: Request): Promise<Response> {
          return Response.json({ ok: true })
        }
      `);

    let resp = await worker.fetch("https://localhost:8080/");
    expect(await resp.json()).toEqual({ ok: true });
    resp = await worker.fetch("https://localhost:8080/");
    expect(await resp.json()).toEqual({ ok: true });

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

    let resp = await worker.fetch("https://localhost:8080/", {
      method: "POST",
      body: "hello",
    });
    expect(await resp.json()).toEqual({ length: 5 });

    worker.terminate();
  });
});
