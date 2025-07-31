import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { resolve } from "https://deno.land/std@0.208.0/path/mod.ts";
import { newDenoHTTPWorker } from "../src/mod.ts";
import { EarlyExitDenoHTTPWorkerError } from "../src/DenoHTTPWorker.ts";

const echoScript = await Deno.readTextFile(resolve(import.meta.dirname!, "./echo-request.ts"));

Deno.test("EarlyExitDenoHTTPWorkerError", () => {
  const error = new EarlyExitDenoHTTPWorkerError("Test", "", "hi", 10, "SIGKILL");
  assertEquals(error.signal, "SIGKILL");
});

Deno.test("basic fetch request", async () => {
  const worker = await newDenoHTTPWorker(
    `export default {
      async fetch(req: Request): Promise<Response> {
        return Response.json({ ok: req.url });
      }
    }`,
    { printOutput: false }
  );

  const request = new Request("https://localhost/hello?query=param");
  const response = await worker.fetch(request);
  const json = await response.json();

  assertEquals(json, { ok: "https://localhost/hello?query=param" });
  await worker.terminate();
});

Deno.test("fetch with headers", async () => {
  const worker = await newDenoHTTPWorker(echoScript, { printOutput: false });

  const request = new Request("https://localhost/test", {
    method: "POST",
    headers: {
      "accept": "application/json",
      "content-type": "application/json"
    },
    body: JSON.stringify({ test: "data" })
  });

  const response = await worker.fetch(request);
  const json = await response.json();

  assertEquals(json.url, "https://localhost/test");
  assertEquals(json.method, "POST");
  assertEquals(json.headers.accept, "application/json");
  assertEquals(json.headers["content-type"], "application/json");
  assertEquals(json.body, '{"test":"data"}');

  await worker.terminate();
});

Deno.test("multiple requests", async () => {
  const worker = await newDenoHTTPWorker(
    `export default {
      async fetch(req: Request): Promise<Response> {
        return Response.json({ url: req.url, timestamp: Date.now() });
      }
    }`,
    { printOutput: false }
  );

  const results = [];
  for (let i = 0; i < 5; i++) {
    const request = new Request(`https://localhost/test${i}`);
    const response = await worker.fetch(request);
    const json = await response.json();
    results.push(json);
  }

  assertEquals(results.length, 5);
  for (let i = 0; i < 5; i++) {
    assertEquals(results[i].url, `https://localhost/test${i}`);
  }

  await worker.terminate();
});

Deno.test("onError handler", async () => {
  const worker = await newDenoHTTPWorker(
    `export default {
      async fetch(req: Request): Promise<Response> {
        throw new Error("Test error");
      },
      onError(error: Error): Response {
        return Response.json({ error: error.message }, { status: 500 });
      }
    }`,
    { printOutput: false }
  );

  const request = new Request("https://localhost/error");
  const response = await worker.fetch(request);
  const json = await response.json();

  assertEquals(response.status, 500);
  assertEquals(json.error, "Test error");

  await worker.terminate();
});

Deno.test("shutdown gracefully", async () => {
  const worker = await newDenoHTTPWorker(
    `export default {
      async fetch(req: Request): Promise<Response> {
        return Response.json({ ok: req.url });
      }
    }`,
    { printOutput: false }
  );

  const exitPromise = new Promise<void>((resolve) => {
    worker.addEventListener("exit", (code) => {
      assertEquals(code, 0);
      resolve();
    });
  });

  const request = new Request("https://localhost/test");
  const response = await worker.fetch(request);
  const json = await response.json();
  assertEquals(json.ok, "https://localhost/test");

  worker.shutdown();
  await exitPromise;
});

Deno.test("import script from file", async () => {
  const file = resolve(import.meta.dirname!, "./echo-request.ts");
  const url = new URL(`file://${file}`);
  const worker = await newDenoHTTPWorker(url, {
    printOutput: false,
    printCommandAndArguments: false,
  });

  const request = new Request("http://localhost/test");
  const response = await worker.fetch(request);
  const json = await response.json();

  assertEquals(json.url, "http://localhost/test");
  assertEquals(json.method, "GET");

  await worker.terminate();
});
