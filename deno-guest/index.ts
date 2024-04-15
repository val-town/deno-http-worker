const scriptType = Deno.args[0];
const script = Deno.args[1];

let handler = await import(`data:text/tsx,${encodeURIComponent(script)}`);
console.log(handler.default);
Deno.serve(
  {
    hostname: "0.0.0.0",
    port: 0,
    onListen: ({ hostname, port }) => {
      console.log("deno-vm-port", port);
    },
  },
  async (req) => {
    console.log(req.url, req);
    if (req.headers.get("X-Deno-VM-RPC")) {
      return Response.json({ fromRPC: true });
    }
    return handler.default(req);
  }
);
