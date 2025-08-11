export default {
  async fetch(req: Request): Promise<Response> {
    console.log(req.keepalive);
    console.log(req.keepalive);
    console.log(req.keepalive);
    console.log(req.keepalive);
    console.log(req.keepalive);
    console.log(req.keepalive);
    console.log(req.keepalive);
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
  },
};
