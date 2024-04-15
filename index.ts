Deno.serve(
  {
    hostname: "0.0.0.0",
    port: 0,
  },
  async (req: Request) => {
    return Response.json({ fromRPC: true });
  }
);
