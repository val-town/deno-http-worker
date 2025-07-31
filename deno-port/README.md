# deno-http-worker (Deno Port)

A Deno-native port of `@valtown/deno-http-worker` that securely spawns Deno workers using native Request/Response objects.

## Key Differences from Node.js Version

- **Native Request/Response API**: Uses `worker.fetch(request)` instead of `worker.request(url, options, callback)`
- **Pure Deno**: No Node.js dependencies, uses Deno's standard library
- **Same Architecture**: Maintains subprocess spawning and Unix socket communication for security

## Usage

```ts
import { newDenoHTTPWorker } from './src/mod.ts';

const worker = await newDenoHTTPWorker(
  `export default {
    async fetch(req: Request): Promise<Response> {
      return Response.json({ ok: req.url });
    },
  }`,
  { printOutput: true, runFlags: ["--allow-net"] }
);

const request = new Request("https://hello/world?query=param", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ data: "value" })
});

const response = await worker.fetch(request);
console.log(await response.json()); // => {"ok":"https://hello/world?query=param"}

worker.terminate();
```

## Testing

```bash
deno task test
```

## Linting

```bash
deno task lint
```

## Formatting

```bash
deno task fmt
```

## Architecture

The port maintains the same security model as the original:

1. Spawns Deno subprocess with restricted permissions
2. Communicates over Unix socket (not network)
3. Serializes Request/Response objects as JSON over the socket
4. User code runs in isolated subprocess with configurable permissions

The main improvement is the cleaner API that leverages Deno's native Request/Response objects instead of Node.js HTTP primitives.