import { getStore } from "@netlify/blobs";

export default async (req) => {
  const token = process.env.SYNC_TOKEN;
  if (token && req.headers.get("x-sync-token") !== token) {
    return new Response("unauthorized", { status: 401 });
  }
  const store = getStore("daddys-list");
  const headers = { "cache-control": "no-store" };
  const rec = (await store.get("chat", { type: "json" })) || { messages: [] };

  if (req.method === "GET") return Response.json(rec, { headers });

  if (req.method === "POST") {
    const b = await req.json();

    // she tapped "Got it" -> mark all alerts as seen
    if (b.ack === true) {
      const now = Date.now();
      rec.messages.forEach((m) => { if (m.alert && !m.ackAt) m.ackAt = now; });
      await store.setJSON("chat", rec);
      return Response.json(rec, { headers });
    }

    // admin deletes one message
    if (b.del && b.from === "daddy") {
      rec.messages = rec.messages.filter((m) => m.id !== b.del);
      await store.setJSON("chat", rec);
      return Response.json(rec, { headers });
    }

    // admin edits one of his own messages
    if (b.edit && b.from === "daddy") {
      const newText = String(b.text || "").trim().slice(0, 1000);
      const target = rec.messages.find((m) => m.id === b.edit && m.from === "daddy");
      if (!target || !newText) return new Response("not found", { status: 404 });
      target.text = newText;
      target.edited = true;
      await store.setJSON("chat", rec);
      return Response.json(rec, { headers });
    }

    // admin cleared the chat
    if (b.clear === true && b.from === "daddy") {
      rec.messages = [];
      await store.setJSON("chat", rec);
      return Response.json(rec, { headers });
    }

    const text = String(b.text || "").trim().slice(0, 1000);
    if (!text) return new Response("empty", { status: 400 });
    const from = b.from === "daddy" ? "daddy" : "lovey";
    const last = rec.messages.length ? rec.messages[rec.messages.length - 1].id : 0;
    const msg = { id: Math.max(Date.now(), last + 1), from, text };
    if (from === "daddy" && b.alert === true) msg.alert = true;
    rec.messages.push(msg);
    rec.messages = rec.messages.slice(-200);
    await store.setJSON("chat", rec);
    return Response.json(msg, { headers });
  }
  return new Response("method not allowed", { status: 405 });
};

export const config = { path: "/api/chat" };
