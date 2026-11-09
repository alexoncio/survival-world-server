import { DurableObject } from "cloudflare:workers";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function makeCode() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => CODE_CHARS[b % CODE_CHARS.length]).join("");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    if (url.pathname === "/api/health") {
      return json({ ok: true, service: "Survival World rooms" });
    }

    if (url.pathname === "/api/create" && request.method === "POST") {
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = makeCode();
        const id = env.ROOMS.idFromName(code);
        const stub = env.ROOMS.get(id);
        const init = await stub.fetch("https://room.internal/init", {
          method: "POST",
        });

        if (init.ok) return json({ code });
      }

      return json({ error: "No se pudo reservar un código. Inténtalo otra vez." }, 503);
    }

    const match = url.pathname.match(/^\/ws\/([A-Z0-9]{6})$/);

    if (match && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const id = env.ROOMS.idFromName(match[1]);
      return env.ROOMS.get(id).fetch(request);
    }

    return json({ error: "Ruta no encontrada" }, 404);
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/init" && request.method === "POST") {
      const createdAt = await this.ctx.storage.get("createdAt");
      const active = Number.isFinite(createdAt) &&
        Date.now() - createdAt < 4 * 60 * 60 * 1000;

      if (active) return new Response("collision", { status: 409 });

      await this.ctx.storage.put("createdAt", Date.now());
      return new Response("ok");
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket requerido", { status: 426 });
    }

    const createdAt = await this.ctx.storage.get("createdAt");

    if (!Number.isFinite(createdAt) ||
        Date.now() - createdAt >= 4 * 60 * 60 * 1000) {
      return new Response("Sala inexistente o caducada", { status: 404 });
    }

    const role = url.searchParams.get("role");
    if (role !== "host" && role !== "guest") {
      return new Response("Rol inválido", { status: 400 });
    }

    const sockets = this.ctx.getWebSockets();
    const roles = sockets.map(ws => ws.deserializeAttachment()?.role);

    if (roles.includes(role)) return new Response("Ese puesto ya está ocupado", { status: 409 });
    if (sockets.length >= 2) return new Response("Sala llena", { status: 409 });
    if (role === "guest" && !roles.includes("host")) {
      return new Response("El creador todavía no está conectado", { status: 409 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role });
    server.send(JSON.stringify({ type: "welcome", role }));

    if (role === "guest") this.broadcast({ type: "peer-joined" }, server);

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    let msg;

    try {
      msg = JSON.parse(
        typeof message === "string" ? message : new TextDecoder().decode(message)
      );
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Mensaje no válido" }));
      return;
    }

    const role = ws.deserializeAttachment()?.role;

    if (msg?.type === "control-ready") {
      if (role === "guest") this.broadcast({ type: "ready" }, ws);
      return;
    }

    if (msg?.type === "control-start") {
      if (role === "host" &&
          this.ctx.getWebSockets().some(s => s.deserializeAttachment()?.role === "guest")) {
        this.broadcast({ type: "start" }, ws);
      }
      return;
    }

    if (msg?.type === "relay" && msg.data && typeof msg.data === "object") {
      this.broadcast({ type: "relay", data: msg.data }, ws);
    }
  }

  webSocketClose(ws) {
    const role = ws.deserializeAttachment()?.role;
    this.broadcast({ type: "peer-left", role }, ws);
  }

  webSocketError(ws) {
    this.webSocketClose(ws);
  }

  broadcast(message, except = null) {
    const data = JSON.stringify(message);

    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except) continue;

      try {
        socket.send(data);
      } catch {
        try {
          socket.close(1011, "error de sala");
        } catch {}
      }
    }
  }
}
