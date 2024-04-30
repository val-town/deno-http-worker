export default async function (req: Request): Promise<Response> {
  const headers: { [key: string]: string } = {};
  for (const [key, value] of req.headers.entries()) {
    headers[key] = value;
  }
  return Response.json({
    url: req.url,
    headers: headers,
    body: await req.text(),
    method: req.method,
  });
}
