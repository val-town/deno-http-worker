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
    let url = new URL(req.url);
    url.host = req.headers.get("X-Deno-Worker-Host");
    url.protocol = req.headers.get("X-Deno-Worker-Protocol") + ":";
    url.port = req.headers.get("X-Deno-Worker-Port");
    req = new Request(url.toString(), req);
    req.headers.delete("X-Deno-Worker-Host");
    req.headers.delete("X-Deno-Worker-Protocol");
    req.headers.delete("X-Deno-Worker-Port");
    return handler.default(req);
  }
);
