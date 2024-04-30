# deno-http-worker

[![NPM version](https://img.shields.io/npm/v/deno-http-worker.svg?style=flat)](https://npmjs.org/package/deno-http-worker)

Similarly to [deno-vm](https://github.com/casual-simulation/node-deno-vm), deno-http-worker lets you securely spawn Deno http servers.

## Usage

```ts
import { newDenoHTTPWorker } from 'deno-http-worker';

let worker = await newDenoHTTPWorker(
    `export default async function (req: Request): Promise<Response> {
        return Response.json({ ok: req.url })
    }`,
    { printOutput: true, runFlags: ["--alow-net"] }
);

let json = await worker.client
    .get("https://hello/world?query=param")
    .json();
console.log(json) // => { ok: 'https://hello/world?query=param' }

worker.terminate();
```

## Internals

Deno-http-worker connects to the Deno process over a single Unix socket http2 connection to make requests. This is for performance and efficiency. As a result, the worker does not provide an address or url, but instead returns an instance of a [got](https://www.npmjs.com/package/got) client that you can make requests with. This ensures that only the underlying `http2.ClientHttp2Session` is used to make requests.

If you need more advanced usage that cannot be covered by `got`, please open a ticket.