let initialized = false;
let initializing = false;
let handler: (req: Request) => Promise<Response> | Response;

let pendingRequests: any[] = [];
export default async function (req: Request): Promise<Response> {
  if (initializing) {
    return new Promise((resolve, reject) => {
      pendingRequests.push({ req, resolve, reject });
    });
  }
  if (!initialized) {
    initializing = true;
    try {
      let source = await req.text();
      if (!source) {
        return new Response("No source provided", { status: 400 });
      }
      handler = (await import(source)).default;
      initialized = true;
      initializing = false;
      for (const { req, resolve } of pendingRequests) {
        resolve(handler(req));
      }
    } catch (e: any) {
      return new Response(e, { status: 500 });
    }
    return new Response("");
  }
  return handler(req);
}
