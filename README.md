# deno-http-worker

[![NPM version](https://img.shields.io/npm/v/@valtown/deno-http-worker.svg?style=flat)](https://npmjs.org/package/@valtown/deno-http-worker)

Similarly to [deno-vm](https://github.com/casual-simulation/node-deno-vm),
deno-http-worker lets you securely spawn Deno http servers.

## Usage

```ts
import { newDenoHTTPWorker } from "@valtown/deno-http-worker";

let worker = await newDenoHTTPWorker(
    `export default {
        async fetch(req: Request): Promise<Response> {
            return Response.json({ ok: req.url });
        },
    }`,
    { printOutput: true, runFlags: ["--allow-net"] },
);

const req = await worker.request({
    url: "https://hello/world?query=param",
    method: "GET",
});
const body = await req.body.json();

console.log(body); // => {"ok":"https://hello/world?query=param"}

worker.terminate();
```

## Internals

> [!TIP]
> This package [globally patches](/deno-bootstrap/index.ts#L28)
> Deno.upgradeWebSocket to enable websocket proxying. You can provide your own
> bootstrap script if different behavior is desired.

Deno-http-worker connects to the Deno process over a Unix socket via undici to
make requests. As a result, the worker does not provide an address or url, but
instead returns `undici.ResponseData` that uses `undici.Pool.request` under the
hood, but modifies the request attributes to work over the socket, and we expose
parts of [request and response interface](./src/types.ts).

You can also connect to the Deno process over a WebSocket connection, which uses
the same `undici.Pool`. We modify the inbound Request objects to preserve
various headers. Unfortunately Deno doesn't let you copy a request and then
modify properties, so we patch `Deno.upgradeWebSocket` when you use the
WebSockets functionality to use the original request for the upgrade, which may
be slightly different.

If you need more advanced usage here, or run into bugs, please open an issue.
