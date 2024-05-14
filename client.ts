import http from "http";
import http2 from "http2-wrapper";
import net from "net";
const options = {
  socketPath: "deno.sock",
  path: "/volumes/list",
};

const t0 = performance.now();
for (let index = 0; index < 1; index++) {
  const callback = (res) => {
    console.log(`STATUS: ${res.statusCode}`);
    res.setEncoding("utf8");
    res.on("data", (data) => console.log(data));
    res.on("error", (data) => console.error(data));
    res.on("end", () => console.log("END", performance.now() - t0));
  };

  const clientRequest = http.request(options, callback);
  clientRequest.end();
}

const _httpSession = http2.connect(`http://whatever`, {
  createConnection: () => net.connect(options.socketPath),
});

_httpSession.on("error", console.error);
_httpSession.on("connect", () => {
  http2.request(
    "http://whatever",
    { method: "GET", h2session: _httpSession },
    (res) => {
      console.log("RESPONSE", res);
    }
  );
});
