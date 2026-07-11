export interface Env {
  DB: D1Database;
  GITHUB_ORG: string;
  GITHUB_WEBHOOK_SECRET: string;
  HEARTBEAT_SECRET: string;
  QUERY_SECRET: string;
}

function isAuthorizedQuery(req: Request, env: Env): boolean {
  return req.headers.get("authorization") === `Bearer ${env.QUERY_SECRET}`;
}

// GitHub-händelser som sannolikt startar (eller kan starta) en CodeRabbit-
// granskning och alltså räknas mot den delade 5/timme-kvoten.
const CODERABBIT_TRIGGERING_ACTIONS: Record<string, string[]> = {
  pull_request: ["opened", "synchronize", "reopened", "ready_for_review"],
};

async function verifyGitHubSignature(
  payload: string,
  signatureHeader: string | null,
  secret: string
): Promise<boolean> {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const expected =
    "sha256=" +
    Array.from(new Uint8Array(mac))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  if (expected.length !== signatureHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  return diff === 0;
}

function triggersCodeRabbit(eventType: string, body: any): boolean {
  if (eventType === "pull_request") {
    return CODERABBIT_TRIGGERING_ACTIONS.pull_request.includes(body?.action);
  }
  if (eventType === "issue_comment") {
    const text = (body?.comment?.body ?? "") as string;
    return /@coderabbitai\s+review/i.test(text);
  }
  return false;
}

async function handleGitHubWebhook(req: Request, env: Env): Promise<Response> {
  const raw = await req.text();
  const sig = req.headers.get("x-hub-signature-256");
  if (!(await verifyGitHubSignature(raw, sig, env.GITHUB_WEBHOOK_SECRET))) {
    return new Response("invalid signature", { status: 401 });
  }
  const eventType = req.headers.get("x-github-event") ?? "unknown";
  const body = JSON.parse(raw);
  const repo = body?.repository?.full_name ?? null;
  const triggers = triggersCodeRabbit(eventType, body) ? 1 : 0;

  // Trunkera payloaden — vi behöver den för felsökning, inte en fullständig arkivering.
  const payloadTrunc = raw.length > 4000 ? raw.slice(0, 4000) : raw;

  await env.DB.prepare(
    `INSERT INTO events (source, event_type, repo, triggers_coderabbit, payload, received_at)
     VALUES ('github', ?, ?, ?, ?, unixepoch())`
  )
    .bind(`${eventType}.${body?.action ?? ""}`, repo, triggers, payloadTrunc)
    .run();

  return new Response("ok", { status: 202 });
}

async function handleHeartbeat(req: Request, env: Env): Promise<Response> {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${env.HEARTBEAT_SECRET}`) {
    return new Response("unauthorized", { status: 401 });
  }
  const body = (await req.json()) as { source_id?: string; status?: string; details?: unknown };
  if (!body.source_id || !body.status) {
    return new Response("source_id and status required", { status: 400 });
  }
  await env.DB.prepare(
    `INSERT INTO heartbeats (source_id, status, last_seen, details)
     VALUES (?, ?, unixepoch(), ?)
     ON CONFLICT(source_id) DO UPDATE SET status = excluded.status, last_seen = excluded.last_seen, details = excluded.details`
  )
    .bind(body.source_id, body.status, JSON.stringify(body.details ?? {}))
    .run();
  return new Response("ok", { status: 202 });
}

async function handleCodeRabbitQuota(env: Env): Promise<Response> {
  const windowStart = Math.floor(Date.now() / 1000) - 3600;
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM events WHERE triggers_coderabbit = 1 AND received_at >= ?`
  )
    .bind(windowStart)
    .first<{ n: number }>();
  const used = row?.n ?? 0;
  const limit = 5; // CodeRabbit Pro-plan, kontogemensamt — se README för källa
  const recent = await env.DB.prepare(
    `SELECT event_type, repo, received_at FROM events
     WHERE triggers_coderabbit = 1 AND received_at >= ?
     ORDER BY received_at DESC LIMIT 20`
  )
    .bind(windowStart)
    .all();
  return Response.json({
    window: "rolling 60 min",
    used,
    limit,
    remaining: Math.max(0, limit - used),
    safe_to_trigger_now: used < limit,
    recent_events: recent.results,
  });
}

async function handleVpsStatus(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(`SELECT * FROM heartbeats ORDER BY source_id`).all();
  const now = Math.floor(Date.now() / 1000);
  const enriched = (rows.results as any[]).map((r) => ({
    ...r,
    details: r.details ? JSON.parse(r.details as string) : {},
    seconds_since_seen: now - (r.last_seen as number),
  }));
  return Response.json({ sources: enriched });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/webhook/github") {
      return handleGitHubWebhook(req, env);
    }
    if (req.method === "POST" && url.pathname === "/webhook/heartbeat") {
      return handleHeartbeat(req, env);
    }
    if (req.method === "GET" && url.pathname === "/coderabbit-quota") {
      if (!isAuthorizedQuery(req, env)) return new Response("unauthorized", { status: 401 });
      return handleCodeRabbitQuota(env);
    }
    if (req.method === "GET" && url.pathname === "/vps-status") {
      if (!isAuthorizedQuery(req, env)) return new Response("unauthorized", { status: 401 });
      return handleVpsStatus(env);
    }
    if (req.method === "GET" && url.pathname === "/") {
      return Response.json({
        service: "ops-hub",
        endpoints: [
          "POST /webhook/github",
          "POST /webhook/heartbeat",
          "GET /coderabbit-quota",
          "GET /vps-status",
        ],
      });
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
