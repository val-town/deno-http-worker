# deno-http-worker

[![NPM version](https://img.shields.io/npm/v/deno-http-worker.svg?style=flat)](https://npmjs.org/package/deno-http-worker)

Similarly to [deno-vm](https://github.com/casual-simulation/node-deno-vm), deno-http-worker lets you securely spawn Deno http servers.

## Usage

```ts
import { newDenoHTTPWorker } from 'deno-http-worker';

let worker = await newDenoHTTPWorker(
    `export default {
        async fetch(req: Request): Promise<Response> {
            return Response.json({ ok: req.url });
        },
    }`,
    { printOutput: true, runFlags: ["--allow-net"] }
);

const req = await worker.request({
    url: "https://hello/world?query=param",
    method: "GET"
})
const body = await req.body.json()

console.log(body) // => {"ok":"https://hello/world?query=param"}

worker.terminate();
```

## Internals

Deno-http-worker connects to the Deno process over a Unix socket to make requests.  As a result, the worker does not provide an address or url, but instead returns `undici.ResponseData` that uses `undici.Pool.request` under the hood, but modifies the request attributes to work over the socket.

If you need more advanced usage here, or run into bugs, please open an issue.