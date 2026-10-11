import { getStore } from "@netlify/blobs";

/*
  /api/state  (sync of the app's localStorage)

  v2 (Oct 10, 2026): MERGE instead of replace.
  Before, every save sent the device's WHOLE snapshot and the last device to save won, so a
  laptop that was a few seconds behind could wipe what the phone had just saved.
  Now a device sends only the keys it changed, each with the value it started from ("base").
  The server does a three-way merge: whatever the device did NOT change keeps the server's
  newest value, whatever it DID change is applied on top. Keys that hold a JSON object
  (daddys-list-state, -history, -live, -movies ...) are merged one inner item at a time, so two
  people ticking different tasks at the same moment both keep their tick.

  PUT body (new):  { patch: { "<key>": { b: <base string|null>, v: <new string|null> } } }
                   v null = the device deleted the key.
  PUT body (old):  { data: { ...whole snapshot } }  still accepted for old cached copies of the
                   page (last write wins, as before).
  Response:        { version, data: <merged whole snapshot> }
*/

/*
  v5 (Oct 10, 2026): DAILY BACKUPS + EXPORT + RESTORE. Nothing about normal saving changed.
  - The first save of each day (day = same 1:00 am Eastern rule the page uses) first stores a dated copy of
    whatever the server held just before it, under the key "backup-YYYY-MM-DD". The newest 14 are kept.
    All of this is wrapped so that if it ever fails, saving still works exactly as before.
  - GET /api/state?backups=1      -> { backups: [dates, newest first], hasUndo: true|false }
  - GET /api/state?export=1       -> the current data as a downloadable file
  - GET /api/state?backup=DATE    -> one stored backup
  - PUT { restore: "YYYY-MM-DD" | "before-restore" } -> puts that backup back as the live data. The data it replaces
    is first kept under "before-restore", so a restore can itself be undone (restore "before-restore").
*/
const KEEP_DAYS = 14;
const dayKey = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" })
  .format(new Date(Date.now() - 3600000));
let backedUpDay = null;
async function maybeBackup(store) {
  try {
    const day = dayKey();
    if (backedUpDay === day) return;
    const key = "backup-" + day;
    const have = await store.get(key, { type: "json" });
    if (!have) {
      const cur = await store.get("state", { type: "json", consistency: "strong" });
      if (!cur || !cur.data) return; // nothing to keep yet
      await store.setJSON(key, { date: day, savedAt: new Date().toISOString(), version: cur.version, data: cur.data });
    }
    backedUpDay = day;
    const l = await store.list({ prefix: "backup-" });
    const keys = ((l && l.blobs) || []).map((b) => b.key).filter((k) => /^backup-\d{4}-\d\d-\d\d$/.test(k)).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) await store.delete(k);
  } catch (e) {
    console.error("backup step failed (saving is not affected):", e && e.message);
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
const DATE = /^\d{4}-\d\d-\d\d$/;

// v4 (Oct 10, 2026): CLOCK FIX. "Newer snapshot wins" compares savedAt stamps written by each device's own
// clock, so a device whose clock is wrong could beat a truly newer save. Every save now carries the device's
// clock reading (header x-client-time). If it is more than 2 minutes off the server's clock, the stamps on the
// items that device just changed are shifted by that difference before merging, so all stamps are in server time.
// Time zones never matter here (savedAt is UTC); only a genuinely wrong clock does. Normal devices are untouched.
const SKEW_LIMIT = 120000;
function fixClock(v, b, skew) {
  if (!skew || typeof v !== "string") return v;
  let V, B;
  try { V = JSON.parse(v); } catch { return v; }
  if (!isObj(V)) return v;
  try { B = b == null ? {} : JSON.parse(b); } catch { B = {}; }
  if (!isObj(B)) B = {};
  let changed = false;
  for (const k of Object.keys(V)) {
    const it = V[k], old = B[k];
    if (isObj(it) && typeof it.savedAt === "string" && !same(it, old) && !(isObj(old) && old.savedAt === it.savedAt)) {
      const t = Date.parse(it.savedAt);
      if (!isNaN(t)) { V[k] = { ...it, savedAt: new Date(t + skew).toISOString() }; changed = true; }
    }
  }
  return changed ? JSON.stringify(V) : v;
}
function fixPatch(patch, skew) {
  if (!skew) return patch;
  const out = {};
  for (const k of Object.keys(patch)) {
    const { b, v } = patch[k] || {};
    out[k] = { b, v: fixClock(v, b, skew) };
  }
  return out;
}

// Both sides changed the same inner item: pick a winner.
function conflict(local, server) {
  if (isObj(local) && isObj(server) && typeof local.savedAt === "string" && typeof server.savedAt === "string") {
    return local.savedAt >= server.savedAt ? local : server; // newer snapshot wins
  }
  if (typeof local === "string" && typeof server === "string" && DATE.test(local) && DATE.test(server)) {
    return local > server ? local : server; // later calendar day wins
  }
  return local; // otherwise the device that is saving wins
}

// Three-way merge of two JSON-object strings.
function mergeObjects(baseStr, localStr, serverStr) {
  let B, L, S;
  try { B = baseStr == null ? {} : JSON.parse(baseStr); L = JSON.parse(localStr); S = JSON.parse(serverStr); } catch { return null; }
  if (!isObj(B)) B = {};
  if (!isObj(L) || !isObj(S)) return null;
  const out = {};
  const keys = new Set([...Object.keys(B), ...Object.keys(L), ...Object.keys(S)]);
  for (const k of keys) {
    const b = B[k], l = L[k], s = S[k];
    let r;
    if (same(l, b)) r = s; // this device did not touch it: keep the server's
    else if (same(s, b)) r = l; // only this device touched it
    else if (same(l, s)) r = l; // both made the same change
    else r = conflict(l, s);
    if (r !== undefined) out[k] = r;
  }
  return JSON.stringify(out);
}

function mergeKey(base, local, server) {
  if (local === server) return local;
  if (local === base) return server; // this device did not change it
  if (server === base || server === undefined) return local; // only this device changed it
  if (local == null) return null; // this device deleted it: deletion wins
  const m = mergeObjects(base, local, server);
  return m !== null ? m : local; // not an object (a plain number or text): saving device wins
}

function applyPatch(current, patch) {
  const data = { ...(current || {}) };
  for (const k of Object.keys(patch)) {
    const { b, v } = patch[k] || {};
    const merged = mergeKey(b == null ? undefined : b, v == null ? null : v, data[k]);
    if (merged == null) delete data[k];
    else data[k] = merged;
  }
  return data;
}

export default async (req) => {
  const token = process.env.SYNC_TOKEN;
  if (token && req.headers.get("x-sync-token") !== token) {
    return new Response("unauthorized", { status: 401 });
  }
  // "strong" = always read the newest saved copy. The default can serve a copy up to a minute old
  // from another region, which let one device save on top of an old copy.
  const store = getStore({ name: "daddys-list", consistency: "strong" });
  const noCache = { "cache-control": "no-store" };

  if (req.method === "GET") {
    const q = new URL(req.url).searchParams;
    try {
      if (q.get("backups")) {
        const l = await store.list({ prefix: "backup-" });
        const dates = ((l && l.blobs) || []).map((b) => b.key).filter((k) => /^backup-\d{4}-\d\d-\d\d$/.test(k)).map((k) => k.slice(7)).sort().reverse();
        const undo = await store.get("before-restore", { type: "json" });
        return Response.json({ backups: dates, hasUndo: !!(undo && undo.data) }, { headers: noCache });
      }
      if (q.get("backup")) {
        if (!DATE.test(q.get("backup"))) return new Response("bad request", { status: 400 });
        const b = await store.get("backup-" + q.get("backup"), { type: "json" });
        return b ? Response.json(b, { headers: noCache }) : new Response("not found", { status: 404 });
      }
      if (q.get("export")) {
        const cur = await store.get("state", { type: "json", consistency: "strong" });
        return new Response(JSON.stringify({ exportedAt: new Date().toISOString(), version: cur ? cur.version : 0, data: cur ? cur.data : null }, null, 1), {
          headers: { ...noCache, "content-type": "application/json", "content-disposition": 'attachment; filename="daddys-list-backup-' + dayKey() + '.json"' },
        });
      }
    } catch (e) {
      return new Response("backup read failed", { status: 500, headers: noCache });
    }
    const rec = await store.get("state", { type: "json", consistency: "strong" });
    return Response.json(rec || { data: null, version: 0 }, { headers: noCache });
  }

  if (req.method === "PUT") {
    let body;
    try { body = await req.json(); } catch { return new Response("bad request", { status: 400 }); }

    // Restore a stored backup (see the v5 note at the top).
    if (body && typeof body.restore === "string") {
      const name = body.restore;
      const key = name === "before-restore" ? "before-restore" : DATE.test(name) ? "backup-" + name : null;
      if (!key) return new Response("bad request", { status: 400 });
      const b = await store.get(key, { type: "json" });
      if (!b || !b.data) return new Response("not found", { status: 404, headers: noCache });
      const cur = await store.get("state", { type: "json", consistency: "strong" });
      if (cur && cur.data) await store.setJSON("before-restore", { date: dayKey(), savedAt: new Date().toISOString(), version: cur.version, data: cur.data });
      const rec = { data: b.data, version: Math.max(Date.now(), ((cur && cur.version) || 0) + 1) };
      await store.setJSON("state", rec);
      return Response.json({ version: rec.version, restored: name }, { headers: noCache });
    }

    await maybeBackup(store); // first save of the day keeps a dated copy of what was there (never blocks saving)

    // Old cached copies of the page: whole snapshot, last write wins.
    if (body && body.data && typeof body.data === "object" && !body.patch) {
      const rec = { data: body.data, version: Date.now() };
      await store.setJSON("state", rec);
      return Response.json({ version: rec.version, data: rec.data }, { headers: noCache });
    }

    if (!body || typeof body.patch !== "object" || !body.patch) return new Response("bad request", { status: 400 });
    const ct = Number(req.headers.get("x-client-time"));
    const rawSkew = Number.isFinite(ct) && ct > 0 ? Date.now() - ct : 0;
    const patch = Math.abs(rawSkew) > SKEW_LIMIT ? fixPatch(body.patch, rawSkew) : body.patch;

    // v4-safe (Oct 10, 2026): plain read, merge, write, then READ BACK and merge again if another save slipped in.
    // (A "conditional write" version was tried first, but it relies on a Netlify Blobs feature that could not be
    // checked offline and may have made every save fail on the real site, so it was taken out.)
    let rec, saved = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, Math.random() * 40 * attempt));
      const cur = await store.get("state", { type: "json", consistency: "strong" });
      const data = applyPatch(cur && cur.data, patch);
      // version must always go up, even if two saves land in the same millisecond
      rec = { data, version: Math.max(Date.now(), ((cur && cur.version) || 0) + 1) };
      await store.setJSON("state", rec);
      const check = await store.get("state", { type: "json", consistency: "strong" });
      if (check && same(check.data, applyPatch(check.data, patch))) { rec = check; saved = true; break; }
    }
    // never tell the device "saved" when it was not: it keeps its edits and retries in a few seconds
    if (!saved) return new Response("busy, retry", { status: 503, headers: noCache });
    return Response.json({ version: rec.version, data: rec.data }, { headers: noCache });
  }
  return new Response("method not allowed", { status: 405 });
};

export const config = { path: "/api/state" };
