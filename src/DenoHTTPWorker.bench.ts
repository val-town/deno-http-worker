import { describe, bench } from "vitest";
import { newDenoHTTPWorker } from "./index.js";

const DEFAULT_HTTP_VAL = `export default { async fetch (req: Request): Promise<Response> {
  let headers = {};
  for (let [key, value] of req.headers.entries()) {
    headers[key] = value;
  }
  return Response.json({ ok: req.url, headers: headers })
} }`;

const opts = { iterations: 20 };

describe("spawn", () => {
  bench(
    "main",
    async () => {
      const worker = await newDenoHTTPWorker(DEFAULT_HTTP_VAL);
      worker.terminate();
    },
    opts
  );
  bench(
    "fast ready",
    async () => {
      const worker = await newDenoHTTPWorker(DEFAULT_HTTP_VAL, {
        next: { fastReady: true },
      });
      worker.terminate();
    },
    opts
  );
  bench(
    "cache bootstrap",
    async () => {
      const worker = await newDenoHTTPWorker(DEFAULT_HTTP_VAL, {
        next: { cacheBootstrap: true },
      });
      worker.terminate();
    },
    opts
  );

  bench(
    "both",
    async () => {
      const worker = await newDenoHTTPWorker(DEFAULT_HTTP_VAL, {
        next: { cacheBootstrap: true, fastReady: true },
      });
      worker.terminate();
    },
    opts
  );
});
