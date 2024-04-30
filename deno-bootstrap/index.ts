const scriptType = Deno.args[0];
const script = Deno.args[1];

const importURL =
  scriptType == "import"
    ? script
    : "data:text/tsx," + encodeURIComponent(script);

const server = Deno.listen({
  hostname: "0.0.0.0",
  port: 0,
});

const addr = server.addr as Deno.NetAddr;

console.log(`deno-listening-port ${addr.port.toString().padStart(5, " ")} `);

// Now that we're listening, start executing user-provided code. We could
// import while starting the server for a small performance improvement,
// but it would complicate reading the port from the Deno logs.
const handler = await import(importURL);
if (!handler.default) {
  throw new Error("No default export found in script.");
}
if (typeof handler.default !== "function") {
  throw new Error("Default export is not a function.");
}

const conn = await server.accept();
(async () => {
  // Reject all additional connections.
  for await (const conn of server) {
    conn.close();
  }
})();

// serveHttp is deprecated, but we don't have many other options if we'd like to
// keep this pattern of rejecting future connections at the TCP level.
// https://discord.com/channels/684898665143206084/1232398264947445810/1234614780111880303
//
// deno-lint-ignore no-deprecated-deno-api
const httpConn = Deno.serveHttp(conn);
for await (const requestEvent of httpConn) {
  (async () => {
    let req = requestEvent.request;
    const url = new URL(req.url);
    url.host = req.headers.get("X-Deno-Worker-Host") || url.host;
    url.protocol = req.headers.get("X-Deno-Worker-Protocol") + ":";
    url.port = req.headers.get("X-Deno-Worker-Port") || url.port;
    req = new Request(url.toString(), req);
    req.headers.delete("X-Deno-Worker-Host");
    req.headers.delete("X-Deno-Worker-Protocol");
    req.headers.delete("X-Deno-Worker-Port");

    await requestEvent.respondWith(handler.default(req));
  })();
}
