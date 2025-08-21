export default {
  fetch: async (req) => {
    if (req.headers.get("upgrade") === "websocket") {
      // For testing: to make sure that it doesn't matter exactly when we do the upgrade
      await new Promise((resolve) => setTimeout(resolve, Math.random()));

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
  },
} satisfies Deno.ServeDefaultExport;
