export interface Env {
  DB: D1Database;
  GITHUB_ORG: string;
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_TOKEN: string;
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

// --- Auto-merge-armare -------------------------------------------------
// Ersätter en timer-baserad molnrutin: armar GitHubs nativa auto-merge
// (squash) på PR:er som är redo. Tillåtna mutationer: auto-merge-flaggan
// (metadata-only, triggar ingen CodeRabbit-granskning) samt vanlig squash-
// merge ENBART som fallback när GitHub vägrar arma en redan-CLEAN PR
// (paritet med gamla rutinens `gh pr merge --auto`). Aldrig kommentarer,
// pushar, force-merge/--admin eller branch protection-ändringar.

const AUTOMERGE_PR_ACTIONS = ["opened", "synchronize", "reopened", "ready_for_review"];
const AUTOMERGE_CHECK_CONCLUSIONS = ["success", "skipped"];

async function githubGraphQL(env: Env, query: string, variables: Record<string, unknown>): Promise<any> {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "content-type": "application/json",
      "user-agent": "ops-hub-worker",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GitHub GraphQL HTTP ${res.status}`);
  const json = (await res.json()) as { data?: any; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
  return json.data;
}

// Vilka PR-nummer i repot berörs av eventet? Tom lista = inget att göra.
async function autoMergeCandidates(env: Env, eventType: string, body: any): Promise<number[]> {
  if (body?.repository?.owner?.login !== env.GITHUB_ORG) return [];
  if (eventType === "pull_request") {
    const n = body?.pull_request?.number;
    return AUTOMERGE_PR_ACTIONS.includes(body?.action) && typeof n === "number" ? [n] : [];
  }
  if (eventType === "check_run" && body?.action === "completed") {
    if (!AUTOMERGE_CHECK_CONCLUSIONS.includes(body?.check_run?.conclusion)) return [];
    const attached = (body.check_run.pull_requests ?? []) as { number: number }[];
    if (attached.length > 0) return attached.map((p) => p.number);
    // pull_requests[] är tomt för fork-PR:er — slå upp via head-SHA istället.
    const sha = body.check_run.head_sha;
    const res = await fetch(
      `https://api.github.com/repos/${body.repository.full_name}/commits/${sha}/pulls`,
      {
        headers: {
          authorization: `Bearer ${env.GITHUB_TOKEN}`,
          accept: "application/vnd.github+json",
          "user-agent": "ops-hub-worker",
        },
      }
    );
    if (!res.ok) return [];
    const prs = (await res.json()) as { number: number; state: string }[];
    return prs.filter((p) => p.state === "open").map((p) => p.number);
  }
  return [];
}

async function maybeArmAutoMerge(env: Env, repoFullName: string, prNumber: number): Promise<void> {
  const [owner, name] = repoFullName.split("/");
  const data = await githubGraphQL(
    env,
    `query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          id state isDraft mergeable mergeStateStatus
          autoMergeRequest { enabledAt }
          commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
        }
      }
    }`,
    { owner, name, number: prNumber }
  );
  const pr = data?.repository?.pullRequest;
  if (!pr) return;
  // Redan armad → no-op (idempotens). Stängd/draft → skippa tyst.
  if (pr.state !== "OPEN" || pr.isDraft || pr.autoMergeRequest) return;
  const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null;
  const ready =
    pr.mergeStateStatus === "CLEAN" ||
    (pr.mergeable === "MERGEABLE" && (rollup === null || rollup === "SUCCESS"));
  // BLOCKED/failing/konflikt/pending → skippa tyst, webhooken kommer igen.
  if (!ready) return;
  let outcome = "armed";
  try {
    await githubGraphQL(
      env,
      `mutation($id: ID!) {
        enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: SQUASH }) {
          clientMutationId
        }
      }`,
      { id: pr.id }
    );
  } catch (e) {
    // GitHub vägrar arma auto-merge på PR:er som redan kan mergas direkt
    // ("Pull request is in clean status"). Utan fallback fastnar en sådan
    // PR för alltid — sista check_run-eventet har redan kommit. Paritet
    // med gamla molnrutinens `gh pr merge --auto`: mergea direkt, ENDAST
    // vid exakt detta fel och bekräftat CLEAN. Alla andra fel bubblar upp
    // till logga-och-skippa.
    if (!(/clean status/i.test(String(e)) && pr.mergeStateStatus === "CLEAN")) throw e;
    await githubGraphQL(
      env,
      `mutation($id: ID!) {
        mergePullRequest(input: { pullRequestId: $id, mergeMethod: SQUASH }) {
          clientMutationId
        }
      }`,
      { id: pr.id }
    );
    outcome = "merged_direct";
  }
  await env.DB.prepare(
    `INSERT INTO events (source, event_type, repo, triggers_coderabbit, payload, received_at)
     VALUES ('ops-hub', ?, ?, 0, ?, unixepoch())`
  )
    .bind(`automerge.${outcome}`, repoFullName, JSON.stringify({ pr: prNumber }))
    .run();
}

async function armAutoMergeForEvent(env: Env, eventType: string, body: any): Promise<void> {
  try {
    const repo = body?.repository?.full_name as string | undefined;
    if (!repo) return;
    for (const prNumber of await autoMergeCandidates(env, eventType, body)) {
      try {
        await maybeArmAutoMerge(env, repo, prNumber);
      } catch (e) {
        // Fel vid armning → logga och gå vidare, ingen retry-storm.
        console.error(`automerge: ${repo}#${prNumber} failed:`, e);
      }
    }
  } catch (e) {
    console.error("automerge: candidate lookup failed:", e);
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

  ctx.waitUntil(armAutoMergeForEvent(env, eventType, body));

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
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
  },
} satisfies ExportedHandler<Env>;
