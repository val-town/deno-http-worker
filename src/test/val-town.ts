let initialized = false;
let initializing = false;
let handler: (req: Request) => Promise<Response> | Response;

const pendingRequests: {
  req: Request;
  resolve: (value: Response | Promise<Response>) => void;
  reject: (reason?: unknown) => void;
}[] = [];
export default {
  async fetch(req: Request): Promise<Response> {
    if (initializing) {
      return new Promise((resolve, reject) => {
        pendingRequests.push({ req, resolve, reject });
      });
    }
    if (!initialized) {
      initializing = true;
      try {
        const importValue = await req.text();
        if (!importValue) {
          // This request will error and future requests will hang.
          return new Response("No source or import value found", {
            status: 400,
          });
        }
        console.log("start import");
        handler = (await import(importValue)).default;
        console.log("end import");
        initialized = true;
        initializing = false;
        for (const { req, resolve } of pendingRequests) {
          resolve(handler(req));
        }
      } catch (e) {
        return new Response(e, { status: 500 });
      }
      return new Response("vt-done");
    }
    return handler(req);
  },
};
