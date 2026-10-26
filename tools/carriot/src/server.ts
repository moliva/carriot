import { join } from "node:path";
import * as core from "./core";
import * as db from "./db";
import * as tmux from "./tmux";
import { isStale, label } from "./types";

const PAGE = join(import.meta.dir, "../web/index.html");
const RECONCILE_EVERY_MS = 10_000;

function snapshot() {
  const artifacts = new Map<string, Record<string, number>>();
  for (const a of db.artifactSummaries()) artifacts.set(a.session_id, { ...artifacts.get(a.session_id), [a.kind]: a.id });
  return core.sorted().map((s) => ({
    ...s,
    display_name: core.displayName(s),
    label: label(s),
    location: core.location(s),
    stale: isStale(s),
    artifacts: artifacts.get(s.id) ?? {},
  }));
}

export function serve(port: number) {
  const token = crypto.randomUUID();
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  let lastReconcile = 0;
  const maybeReconcile = () => {
    if (Date.now() - lastReconcile < RECONCILE_EVERY_MS) return;
    lastReconcile = Date.now();
    core.reconcile();
    core.listBackgroundAsync().then(core.syncBackground, () => {});
  };

  const json = (data: unknown, status = 200) => Response.json(data, { status });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 0,
    async fetch(req) {
      // Host check defeats DNS rebinding; the token defeats cross-site requests from any other page.
      if (!allowedHosts.has(req.headers.get("host") ?? "")) return new Response("forbidden", { status: 403 });
      const url = new URL(req.url);

      if (url.pathname === "/") {
        const html = (await Bun.file(PAGE).text()).replace("__CARRIOT_TOKEN__", token);
        return new Response(html, {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" },
        });
      }

      if (!url.pathname.startsWith("/api/")) return new Response("not found", { status: 404 });
      if ((req.headers.get("x-carriot-token") ?? url.searchParams.get("token")) !== token)
        return new Response("forbidden", { status: 403 });

      if (url.pathname === "/api/stream") return stream(req.signal, maybeReconcile);
      if (url.pathname === "/api/sessions") {
        maybeReconcile();
        return json(snapshot());
      }

      const art = url.pathname.match(/^\/api\/artifacts\/(\d+)$/);
      if (art) {
        const a = db.getArtifact(Number(art[1]));
        return a ? json({ ...a, meta: a.meta ? JSON.parse(a.meta) : {} }) : json({ error: "not found" }, 404);
      }

      const m = url.pathname.match(/^\/api\/sessions\/([\w-]+)\/(screen|jump|send|park)$/);
      if (!m) return json({ error: "not found" }, 404);
      const s = db.getSession(m[1]);
      if (!s) return json({ error: "session not found" }, 404);

      if (m[2] === "screen") return json({ text: core.screen(s, Number(url.searchParams.get("lines") ?? 120)) ?? "" });
      if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
      if (m[2] === "jump") {
        const r = core.reconnect(s);
        if (r.error || !r.pane) return json({ error: r.error }, 409);
        tmux.jump(r.pane, true);
        return json({ ok: true });
      }
      if (m[2] === "park") {
        const r = core.location(s) === "parked" ? core.reconnect(s) : core.sendAway(s);
        return "error" in r && r.error ? json({ error: r.error }, 409) : json({ ok: true, message: "message" in r ? r.message : "Back in tmux." });
      }
      if (!s.pane) return json({ error: "Attach to the session first (Open in terminal), then reply." }, 409);
      const body = (await req.json().catch(() => ({}))) as { text?: string };
      if (!body.text?.trim()) return json({ error: "empty message" }, 400);
      return json({ ok: tmux.sendText(s.pane, body.text) });
    },
  });
  console.log(`carriot dashboard on http://127.0.0.1:${server.port}`);
}

/** SSE: pushes a fresh snapshot whenever another connection writes to the database. */
function stream(signal: AbortSignal, maybeReconcile: () => void): Response {
  const enc = new TextEncoder();
  const version = db.open().query<{ data_version: number }, []>("PRAGMA data_version");
  return new Response(
    new ReadableStream({
      start(ctrl) {
        let last = -1;
        let ticks = 0;
        const send = (event: string, data: string) => ctrl.enqueue(enc.encode(`event: ${event}\ndata: ${data}\n\n`));
        const tick = () => {
          ticks++;
          if (ticks % 20 === 0) maybeReconcile();
          const v = version.get()?.data_version ?? 0;
          if (v !== last || ticks % 20 === 0) {
            last = v;
            send("sessions", JSON.stringify(snapshot()));
          }
        };
        tick();
        const timer = setInterval(tick, 500);
        signal.addEventListener("abort", () => {
          clearInterval(timer);
          try {
            ctrl.close();
          } catch {}
        });
      },
    }),
    { headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" } },
  );
}
