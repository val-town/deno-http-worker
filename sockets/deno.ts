Deno.serve({ path: "./socket.sock" }, async (r: Request) => {
  return Response.json({ ok: true });
});
