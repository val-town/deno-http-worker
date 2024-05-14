const server = Deno.serve({ path: "deno.sock" }, (req: Request) => {
  console.log(req);
  return Response.json({
    headers: req.headers,
    url: req.url,
    method: req.method,
  });
});
