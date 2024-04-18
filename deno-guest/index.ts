const scriptType = Deno.args[0];
const script = Deno.args[1];

const importURL =
  scriptType == "import"
    ? script
    : "data:text/tsx," + encodeURIComponent(script);

let handler: { default: (req: Request) => Promise<Response> | Response };
let importing = true;
let pendingRequests: {
  req: Request;
  resolve: (value: Response | PromiseLike<Response>) => void;
  reject: (reason?: unknown) => void;
}[] = [];

Deno.serve(
  {
    hostname: "0.0.0.0",
    port: 0,
    // Listen on a randomly assigned port and
    onListen: async ({ port }) => {
      console.log(`deno-listening-port ${port.toString().padStart(5, " ")} `);
      // Now that we're listening, start executing user-provided code. We could
      // import while starting the server for a small performance improvement,
      // but it would complicate reading the port from the Deno logs.
      handler = await import(importURL);
      if (!handler.default) {
        throw new Error("No default export found in script.");
      }
      if (typeof handler.default !== "function") {
        throw new Error("Default export is not a function.");
      }
      importing = false;
      for (const { req, resolve } of pendingRequests) {
        resolve(handler.default(req));
      }
      pendingRequests = [];
    },
  },
  (req: Request) => {
    // Re-create request with correct URL.
    const url = new URL(req.url);
    url.host = req.headers.get("X-Deno-Worker-Host") || url.host;
    url.protocol = req.headers.get("X-Deno-Worker-Protocol") + ":";
    url.port = req.headers.get("X-Deno-Worker-Port") || url.port;
    req = new Request(url.toString(), req);
    req.headers.delete("X-Deno-Worker-Host");
    req.headers.delete("X-Deno-Worker-Protocol");
    req.headers.delete("X-Deno-Worker-Port");

    if (importing) {
      // Queue up requests while importing.
      return new Promise((resolve, reject) => {
        pendingRequests.push({ req, resolve, reject });
      });
    }
    return handler.default(req);
  }
);
