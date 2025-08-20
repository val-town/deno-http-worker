declare global {
  interface Request {
    _original: Request;
  }
}

const socketFile = Deno.args[0];
const scriptType = Deno.args[1];
const script = Deno.args[2];

const importURL = scriptType === "import"
  ? script
  : `data:text/tsx,${encodeURIComponent(script)}`;

const mod = await import(importURL);
if (!mod.default) {
  throw new Error("No default export found in script.");
}
if (typeof mod.default.fetch !== "function") {
  throw new Error("Default export does not have a fetch function.");
}

const onError = mod.default.onError ??
  ((error: unknown) => {
    console.error(error);
    return new Response("Internal Server Error", { status: 500 });
  });
const onListen = mod.default.onListen ?? ((_localAddr: Deno.NetAddr) => { });

// Use an empty onListen callback to prevent Deno from logging
const server = Deno.serve(
  {
    path: socketFile,
    onListen: onListen,
    onError: onError,
  },
  (originalReq: Request) => {
    const headerUrl = originalReq.headers.get("X-Deno-Worker-URL");
    if (!headerUrl) {
      // This is just for the warming request, shouldn't be seen by clients.
      return Response.json({ warming: true }, { status: 200 });
    }

    // We can't modify the headers of a WebSocket request and reconstructing the
    // request breaks it
    const url = new URL(headerUrl);
    // Deno Request headers are immutable so we must make a new Request in order
    // to delete our headers.
    const req = new Request(url.toString(), originalReq);
    req._original = originalReq;

    // Restore host and connection headers.
    req.headers.delete("host");
    req.headers.delete("connection");
    if (req.headers.has("X-Deno-Worker-Host")) {
      req.headers.set("host", req.headers.get("X-Deno-Worker-Host")!);
    }
    if (req.headers.has("X-Deno-Worker-Connection")) {
      req.headers.set(
        "connection",
        req.headers.get("X-Deno-Worker-Connection")!,
      );
    }

    req.headers.delete("X-Deno-Worker-URL");
    req.headers.delete("X-Deno-Worker-Host");
    req.headers.delete("X-Deno-Worker-Connection");

    // Deno.upgradeWebSocket only will work with the original request object,
    // copied objects do not work. We want to give the user headers as similar
    // to the original ones as possible, but for the actual upgrade handshake we
    // will always want to use the original request.
    const originalUpgrade = Deno.upgradeWebSocket
    Object.defineProperty(Deno, "upgradeWebSocket", {
      // Since they only have one entrypoint it should be ok to just totally override this
      value: () => {
        return originalUpgrade(req._original);
      },
    })

    return mod.default.fetch(req);
  },
);

addEventListener("error", (e) => {
  console.error(e.error);
  e.preventDefault();
});

addEventListener("unhandledrejection", (e) => {
  console.error(e.reason);
  e.preventDefault();
});

Deno.addSignalListener("SIGINT", async () => {
  // On interrupt we only shut down the server. Deno will wait for all
  // unresolved promises to complete before exiting.
  await server.shutdown();
});
