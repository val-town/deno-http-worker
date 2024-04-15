import { DenoHTTPWorker } from "../../src/index.js";

(async () => {
  let server =
    new DenoHTTPWorker(`export default async function (req: Request): Promise<Response> {
        return Response.json({ ok: true })
      }`);
  console.log(await server.send("ok"));
})();
