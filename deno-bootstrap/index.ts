const socketFile = Deno.args[0];
const scriptType = Deno.args[1];
const script = Deno.args[2];

const importURL =
  scriptType == "import"
    ? script
    : "data:text/tsx," + encodeURIComponent(script);

const handler = await import(importURL);
if (!handler.default) {
  throw new Error("No default export found in script.");
}
if (typeof handler.default !== "function") {
  throw new Error("Default export is not a function.");
}

// Use an empty onListen callback to prevent Deno from logging
const server = Deno.serve(
  { path: socketFile, onListen: () => {} },
  (req: Request) => {
    const url = new URL(req.url);
    url.host = req.headers.get("X-Deno-Worker-Host") || url.host;
    url.port = req.headers.get("X-Deno-Worker-Port") || url.port;
    // Setting url.protocol did not replace the protocol correctly for a unix
    // socket. Replacing the href value seems to work well.
    url.href = url.href.replace(
      /^http\+unix:/,
      req.headers.get("X-Deno-Worker-Protocol") || url.protocol
    );
    // Deno Request headers are immutable so we must make a new Request in order to delete our headers
    req = new Request(url.toString(), req);
    req.headers.delete("X-Deno-Worker-Host");
    req.headers.delete("X-Deno-Worker-Protocol");
    req.headers.delete("X-Deno-Worker-Port");

    return handler.default(req);
  }
);

Deno.addSignalListener("SIGINT", async () => {
  // On interrupt we only shut down the server. We will wait for all other
  // unresolved promises before exiting.
  await server.shutdown();
});
