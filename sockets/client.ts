import htt2 from "http2-wrapper";
import net from "net";

const client = htt2.connect("http://whatever", {
  createConnection: () => net.connect("787562857674825-deno-http.sock"),
});
