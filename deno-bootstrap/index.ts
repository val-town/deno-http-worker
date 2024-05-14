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
    const headerUrl = req.headers.get("X-Deno-Worker-URL");
    if (!headerUrl) {
      // This is just for the warming request, shouldn't be seen by clients.
      return Response.json({}, { status: 401 });
    }
    const url = new URL(headerUrl);
    // Deno Request headers are immutable so we must make a new Request in order
    // to delete our headers.
    req = new Request(url.toString(), req);

    // Restore host and connection headers.
    req.headers.delete("host");
    req.headers.delete("connection");
    if (req.headers.has("X-Deno-Worker-Host"))
      req.headers.set("host", req.headers.get("X-Deno-Worker-Host")!);
    if (req.headers.has("X-Deno-Worker-Connection"))
      req.headers.set(
        "connection",
        req.headers.get("X-Deno-Worker-Connection")!
      );

    req.headers.delete("X-Deno-Worker-URL");
    return handler.default(req);
  }
);

Deno.addSignalListener("SIGINT", async () => {
  // On interrupt we only shut down the server. Deno will wait for all
  // unresolved promises to complete before exiting.
  await server.shutdown();
});
