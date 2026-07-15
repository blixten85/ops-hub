import * as Sentry from "@sentry/cloudflare";

export interface Env {
  DB: D1Database;
  AI: Ai;
  GITHUB_ORG: string;
  GITHUB_WEBHOOK_SECRET: string;
  HEARTBEAT_SECRET: string;
  QUERY_SECRET: string;
  // PAT med issues:write på alla repon — bara för att posta @claude-
  // eskaleringskommentarer, samma mekanism som claude-assign-trigger.yml.
  GITHUB_TOKEN: string;
  // Sentry-felspårning (allmän, ej AI Agent Monitoring). Sätts som secret.
  SENTRY_DSN?: string;
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

// GitHubs pull_request_review_thread-event har bara actions "resolved" och
// "unresolved". En NY olöst tråd skickar "unresolved"; om den löses upp igen
// och blir olöst på nytt skickas "unresolved" igen också, men det är
// fortfarande rätt signal ("den här tråden kräver ett beslut just nu").
// Författaren till trådens första kommentar avgör om det är CodeRabbit.

const ESCALATION_DEBOUNCE_SECONDS = 30 * 60;
// Efter så här många @claude-eskaleringar på samma PR (utan att tråden slutar
// bli olöst) ger vi upp och lämnar den för manuell granskning istället för
// att fortsätta posta kommentarer — samma säkerhetsgräns som
// coderabbit-queues MAX_AUTOFIX_ATTEMPTS, och av samma anledning (undvik en
// långsam variant av 1500kr/6h-loop-incidenten i politiker-webapp).
const MAX_ESCALATIONS_PER_PR = 3;

type ThreadAction = "skip" | "autofix" | "escalate";

// Klassificerar en olöst CodeRabbit-tråd med Workers AI så att bara genuint
// tvetydiga/arkitekturfynd eskaleras — resten är antingen redan täckta av
// coderabbit-queues autofix-loop eller för triviala för att vara värda ett
// avbrott. Fail-safe: allt som inte går att tolka som ett rent skip/autofix-
// svar eskaleras hellre än att tystas ner.
async function classifyThread(env: Env, commentBody: string): Promise<{ action: ThreadAction; reasoning: string }> {
  const prompt = `Du klassificerar ett CodeRabbit-granskningsfynd på en GitHub-PR. Svara ENDAST med ett JSON-objekt: {"action": "skip"|"autofix"|"escalate", "reasoning": "kort motivering på svenska"}.

- "skip": trivialt/stilfynd utan verklig risk (t.ex. dependency-pinning-stil, kommentarsformat).
- "autofix": ett konkret, mekaniskt fixbart fynd (t.ex. saknad felhantering, fel strängjämförelse, saknad null-check) som en AI-kodagent kan lösa utan att behöva ett produktbeslut.
- "escalate": kräver ett mänskligt/arkitekturbeslut (säkerhetsavvägning, breaking change, affärslogik, något genuint tvetydigt).

Fyndet:
${commentBody.slice(0, 3000)}`;

  try {
    const result = (await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [{ role: "user", content: prompt }],
      max_tokens: 200,
    })) as { response?: string };
    const text = result?.response ?? "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { action: "escalate", reasoning: "AI-svar gick inte att tolka som JSON" };
    const parsed = JSON.parse(match[0]) as { action?: string; reasoning?: unknown };
    if (parsed.action === "skip" || parsed.action === "autofix" || parsed.action === "escalate") {
      return { action: parsed.action, reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "" };
    }
    return { action: "escalate", reasoning: `okänt action-värde: ${parsed.action}` };
  } catch (e) {
    console.error("classifyThread: Workers AI-anrop misslyckades:", e);
    return { action: "escalate", reasoning: "Workers AI-anrop misslyckades" };
  }
}

// Meddelandet är MEDVETET statiskt — varken den olösta trådens råa text
// (commentBody) eller Workers AI:s reasoning-fält interpolreras hit.
// commentBody kommer från en extern, opålitlig källa (allt en PR-författare
// kan skriva in i sin kod triggar CodeRabbit-kommentarer), och reasoning är
// ett AI-genererat svar byggt på den texten — att klistra in någotdera i en
// autonom @claude-prompt öppnar för prompt injection (CWE-1427, flaggat av
// CodeRabbit). Claude GitHub App:en läser redan själv PR:ens olösta trådar
// när den blir taggad, så den behöver inte få texten återberättad här.
async function postClaudeEscalationComment(env: Env, repo: string, prNumber: number): Promise<boolean> {
  const res = await fetch(`https://api.github.com/repos/${repo}/issues/${prNumber}/comments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "ops-hub",
    },
    body: JSON.stringify({
      body: `@claude Ett CodeRabbit-fynd på denna PR har klassificerats som att det kräver ett mänskligt/arkitekturbeslut. Undersök de olösta review-trådarna och föreslå en lösning, eller förklara varför de kan avfärdas.`,
    }),
  });
  if (!res.ok) {
    console.error(`postClaudeEscalationComment: GitHub API svarade ${res.status} för ${repo}#${prNumber}`);
    return false;
  }
  return true;
}

async function handleUnresolvedThread(env: Env, body: any): Promise<void> {
  try {
    const repo = body?.repository?.full_name as string | undefined;
    const prNumber = body?.pull_request?.number as number | undefined;
    const author = (body?.thread?.comments?.[0]?.user?.login ?? "") as string;
    const commentBody = (body?.thread?.comments?.[0]?.body ?? "") as string;
    if (!repo || !prNumber || !/^coderabbitai(\[bot\])?$/i.test(author) || !commentBody) return;

    const { action, reasoning } = await classifyThread(env, commentBody);

    await env.DB.prepare(
      `INSERT INTO thread_classifications (repo, pr_number, action, reasoning, classified_at)
       VALUES (?, ?, ?, ?, unixepoch())`
    )
      .bind(repo, prNumber, action, reasoning.slice(0, 500))
      .run();

    if (action !== "escalate") return; // "skip" och "autofix" hanteras redan av coderabbit-queue/ingenting

    // Atomär check-and-set: debounce OCH max-räknare kollas och uppdateras i
    // SAMMA SQL-sats, så två samtidiga webhook-leveranser för samma PR inte
    // båda kan passera check-en innan någon hunnit inkrementera (TOCTOU-
    // race om detta gjordes som en separat SELECT följt av en UPDATE).
    const result = await env.DB.prepare(
      `INSERT INTO escalated_threads (repo, pr_number, escalated_at, escalation_count) VALUES (?, ?, unixepoch(), 1)
       ON CONFLICT(repo, pr_number) DO UPDATE SET escalated_at = excluded.escalated_at, escalation_count = escalated_threads.escalation_count + 1
       WHERE excluded.escalated_at - escalated_threads.escalated_at >= ? AND escalated_threads.escalation_count < ?`
    )
      .bind(repo, prNumber, ESCALATION_DEBOUNCE_SECONDS, MAX_ESCALATIONS_PER_PR)
      .run();
    if (!result.meta.changes) return; // redan eskalerad senaste 30 min, eller max antal eskaleringar nått

    const ok = await postClaudeEscalationComment(env, repo, prNumber);
    if (!ok) {
      // Rulla tillbaka debounce-reservationen (men behåll räknaren orörd —
      // detta försök räknas inte om kommentaren aldrig postades) så nästa
      // event kan försöka igen direkt istället för att vänta ut hela
      // 30-minuters-fönstret.
      await env.DB.prepare(
        `UPDATE escalated_threads SET escalated_at = 0, escalation_count = escalation_count - 1 WHERE repo = ? AND pr_number = ?`
      )
        .bind(repo, prNumber)
        .run();
    }
  } catch (e) {
    console.error(`pull_request_review_thread: hantering misslyckades för ${body?.repository?.full_name}#${body?.pull_request?.number}:`, e);
  }
}

async function handleGitHubWebhook(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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

  if (eventType === "pull_request_review_thread" && body?.action === "unresolved") {
    ctx.waitUntil(handleUnresolvedThread(env, body));
  }

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

async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "POST" && url.pathname === "/webhook/github") {
    return handleGitHubWebhook(req, env, ctx);
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
}

export default Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    tracesSampleRate: 1.0,
  }),
  {
    async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      try {
        return await route(req, env, ctx);
      } catch (err) {
        console.error(err);
        Sentry.captureException(err);
        return new Response("internal error", { status: 500 });
      }
    },
  } satisfies ExportedHandler<Env>,
);
