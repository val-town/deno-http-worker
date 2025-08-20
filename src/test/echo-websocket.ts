export default {
  fetch: (req) => {
    if (req.headers.get("upgrade") === "websocket") {
      const { socket, response } = Deno.upgradeWebSocket(req);

      socket.addEventListener("open", () => {
        console.log("WebSocket connection opened");
      });

      socket.addEventListener("message", (event) => {
        console.log("Received message:", event.data);
        socket.send(event.data);
      });

      socket.addEventListener("error", (event) => {
        console.error("WebSocket error:", event);
      });

      return response;
    }

    return new Response("Not a websocket request", { status: 400 });
  }
} satisfies Deno.ServeDefaultExport;