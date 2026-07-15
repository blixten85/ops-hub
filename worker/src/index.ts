import * as Sentry from "@sentry/cloudflare";

export interface Env {
  DB: D1Database;
  AI: Ai;
  GITHUB_ORG: string;
  GITHUB_WEBHOOK_SECRET: string;
  // PAT med issues:write och admin på alla repon — auto-merge-armering,
  // @claude-eskalering och Slack->GitHub-vidarebefordran.
  GITHUB_TOKEN: string;
  HEARTBEAT_SECRET: string;
  QUERY_SECRET: string;
  CF_ADMIN_TOKEN: string;
  CF_READONLY_TOKEN: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_WEBHOOK_URL?: string;
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

// Wrapper för utgående fetch med per-request timeout (AbortController).
// Förhindrar att en hängd uppström-tjänst (GitHub/Slack/Cloudflare) låser
// workern på obestämd tid. Timern rensas alltid (try/finally) så den inte läcker.
async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 10000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
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
  const res = await fetchWithTimeout("https://api.github.com/graphql", {
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
    const res = await fetchWithTimeout(
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

// --- CodeRabbit olöst review-tråd → AI-triage → @claude-eskalering --------
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
// `retryable` skiljer transienta fel (nätverk/5xx — värt att rulla tillbaka
// och försöka igen) från permanenta (401/403/404/422 — fel GITHUB_TOKEN eller
// PR:en finns inte längre). Utan denna åtskillnad skulle en permanent
// konfigurationsbugg (t.ex. utgånget token) rulla tillbaka räknaren varje
// gång och försöka om i all oändlighet, och MAX_ESCALATIONS_PER_PR skulle
// aldrig få effekt.
//
// Medvetet INGEN maintainer-label/approval-spärr innan eskalering (skiljer
// sig från ett CodeRabbit-autofix-förslag som lades till här): ops-hub
// hanterar bara blixten85s egna repon, ingen extern publik contribution —
// hotmodellen bakom det förslaget (godtycklig utomstående PR-författare
// triggar en autonom agent-körning) gäller inte här. En sådan spärr skulle
// dessutom göra escalate-grenen (till för fynd som KRÄVER ett mänskligt
// beslut) i praktiken aldrig automatisk, eftersom en PR med den typen av
// fynd sällan redan är godkänd.
async function postClaudeEscalationComment(
  env: Env,
  repo: string,
  prNumber: number
): Promise<{ ok: boolean; retryable: boolean }> {
  const res = await fetchWithTimeout(`https://api.github.com/repos/${repo}/issues/${prNumber}/comments`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "ops-hub-worker",
    },
    body: JSON.stringify({
      body: `@claude Ett CodeRabbit-fynd på denna PR har klassificerats som att det kräver ett mänskligt/arkitekturbeslut. Undersök de olösta review-trådarna och föreslå en lösning, eller förklara varför de kan avfärdas.`,
    }),
  });
  if (!res.ok) {
    console.error(`postClaudeEscalationComment: GitHub API svarade ${res.status} för ${repo}#${prNumber}`);
    return { ok: false, retryable: res.status >= 500 };
  }
  return { ok: true, retryable: false };
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

    const { ok, retryable } = await postClaudeEscalationComment(env, repo, prNumber);
    if (!ok && retryable) {
      // Rulla tillbaka debounce-reservationen OCH räknaren (med undre gräns
      // 0, annars kan upprepade transienta fel driva räknaren negativ och
      // effektivt kringgå MAX_ESCALATIONS_PER_PR) — bara för transienta fel.
      // Permanenta fel (401/403/404 m.fl.) rullas INTE tillbaka: räknaren
      // ska fortsätta stiga mot gränsen så en trasig konfiguration ger upp
      // istället för att försöka om i all oändlighet.
      await env.DB.prepare(
        `UPDATE escalated_threads SET escalated_at = 0, escalation_count = MAX(escalation_count - 1, 0) WHERE repo = ? AND pr_number = ?`
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

  ctx.waitUntil(armAutoMergeForEvent(env, eventType, body));

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

// --- Slack-helper (endast utgående) ---------------------------------------
// Får ALDRIG kasta — notiser är best effort, övrig logik ska överleva. Bara
// utgående alerts (hälsokontroller, token-underhåll) — ingen inkommande
// Slack-relä (Events API) längre; @claude-eskalering sker direkt via
// postClaudeEscalationComment ovan istället.

const SLACK_CHANNEL = "C0BD5U2RWD6";

async function postSlack(env: Env, text: string): Promise<{ ok: boolean; ts: string | null }> {
  try {
    if (env.SLACK_BOT_TOKEN) {
      const res = await fetchWithTimeout("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ channel: SLACK_CHANNEL, text }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string; ts?: string };
      if (!res.ok || !json.ok) {
        console.warn(`slack: chat.postMessage misslyckades (HTTP ${res.status}):`, json.error);
        return { ok: false, ts: null };
      }
      return { ok: true, ts: json.ts ?? null };
    }
    if (env.SLACK_WEBHOOK_URL) {
      const res = await fetchWithTimeout(env.SLACK_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        console.warn(`slack: incoming webhook misslyckades (HTTP ${res.status}):`, await res.text());
        return { ok: false, ts: null };
      }
      return { ok: true, ts: null };
    }
    console.warn("slack: varken SLACK_BOT_TOKEN eller SLACK_WEBHOOK_URL satt — meddelande ej skickat:", text);
    return { ok: false, ts: null };
  } catch (e) {
    console.warn("slack: post misslyckades:", e);
    return { ok: false, ts: null };
  }
}

// --- Cloudflare API-helper ------------------------------------------------

const CF_ACCOUNT_ID = "b74f8c0c6a92f3006483840cf27372fd";

async function cfApi(token: string, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetchWithTimeout(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as { success?: boolean; result?: unknown; errors?: unknown };
  if (!json.success) {
    throw new Error(`CF API ${method} ${path}: HTTP ${res.status} ${JSON.stringify(json.errors ?? [])}`);
  }
  return json.result;
}

// --- Token-underhåll (veckovis cron) ---------------------------------------
// Porterad från timer-baserad molnrutin: förnyar Cloudflare account-tokens
// som saknar utgångsdatum eller går ut inom 30 dagar → sätt exakt 1 år fram.
// HÅRDA REGLER: rör ALDRIG token 7fe0985e91f909d888690eec40625612 (mp100-
// server, avsiktligt utanför listan), DELETE:a aldrig någon token, och
// PUT-kroppen måste bära befintlig policies-array oförändrad (annars
// strippas åtkomsten tyst).

const MANAGED_CF_TOKENS: { id: string; label: string }[] = [
  { id: "4fc391e14c1126872116b94c56270674", label: "admin" },
  { id: "6ce6b014c5e660147f0ed08e17f4cdd5", label: "deploy" },
  { id: "468c30efcbecfd03b0c664b56b4862bd", label: "readonly" },
];

// GH_TOKEN (repo-secret i politiker-webapp, fine-grained PAT) går ut ~2026-09-21
// och kan bara förnyas manuellt av en människa — varna i god tid.
const GH_TOKEN_WARN_FROM = "2026-09-07";

async function maintainCfTokens(env: Env): Promise<void> {
  const lines: string[] = [];
  const now = Date.now();
  const thirtyDays = 30 * 24 * 3600 * 1000;
  const renewDate = new Date(now);
  renewDate.setUTCFullYear(renewDate.getUTCFullYear() + 1);
  const newDateStr = renewDate.toISOString().slice(0, 10); // YYYY-MM-DD
  const newExpiresOn = `${newDateStr}T23:59:59Z`;

  for (const { id, label } of MANAGED_CF_TOKENS) {
    try {
      const token = await cfApi(env.CF_ADMIN_TOKEN, "GET", `/accounts/${CF_ACCOUNT_ID}/tokens/${id}`);
      const expiresOn = token?.expires_on as string | null | undefined;
      const needsRenewal = !expiresOn || new Date(expiresOn).getTime() - now < thirtyDays;
      if (!needsRenewal) {
        lines.push(`✅ ${label}: OK (går ut ${expiresOn!.slice(0, 10)})`);
        continue;
      }
      // Uppdatera datummönstret "expires YYYY-MM-DD" i namnet om det finns.
      const name = (token.name as string).replace(/expires \d{4}-\d{2}-\d{2}/, `expires ${newDateStr}`);
      const putBody: Record<string, unknown> = {
        name,
        policies: token.policies, // MÅSTE skickas oförändrad — annars strippas åtkomst tyst
        status: token.status,
        expires_on: newExpiresOn,
      };
      if (token.condition) putBody.condition = token.condition;
      if (token.not_before) putBody.not_before = token.not_before;
      await cfApi(env.CF_ADMIN_TOKEN, "PUT", `/accounts/${CF_ACCOUNT_ID}/tokens/${id}`, putBody);
      lines.push(`🔄 ${label}: förnyad till ${newDateStr} (var: ${expiresOn ? expiresOn.slice(0, 10) : "utan utgångsdatum"})`);
    } catch (e) {
      // Fel på enskild token → rapportera, krascha inte hela körningen.
      lines.push(`❌ ${label} (${id.slice(0, 8)}…): ${String(e).slice(0, 200)}`);
      console.error(`token-underhåll: ${label} misslyckades:`, e);
    }
  }

  let text = lines.every((l) => l.startsWith("✅"))
    ? `✅ Alla tokens OK\n${lines.join("\n")}`
    : `🔧 Token-underhåll:\n${lines.join("\n")}`;

  if (new Date().toISOString().slice(0, 10) >= GH_TOKEN_WARN_FROM) {
    text +=
      "\n\n⚠️ VARNING: repo-secreten GH_TOKEN (fine-grained PAT, politiker-webapp) går ut ~2026-09-21 " +
      "och kan BARA förnyas manuellt:\n" +
      "1. github.com/settings/personal-access-tokens → Generate new (fine-grained)\n" +
      "2. Repository access: Only blixten85/politiker-webapp\n" +
      "3. Permissions: Code scanning alerts (Read), Dependabot alerts (Read), Issues (Read/Write)\n" +
      "4. Ge värdet till Claude för `gh secret set GH_TOKEN`";
  }

  await postSlack(env, text);
}

// --- Healthcheck politiker.denied.se (var 5:e min) --------------------------
// Porterad från timer-baserad molnrutin. Slackar ENDAST vid transition
// (OK→FAIL urgent med åtgärdsförslag, FAIL→OK återställt) + max en
// påminnelse per 6h vid kvarstående FAIL. Daglig 07:00-summering separat.

// Zon-id för politiker.denied.se: 9b017d0f7284906721545dcca5fdf61e (referens,
// används inte av kontrollerna själva — allt går via account-scopade endpoints).
const POLITIKER_D1_UUID = "e9ecf94f-fa71-4004-a5b8-f9317eb4d4e9";
const POLITIKER_HOST = "politiker.denied.se";

interface HealthResult {
  id: string;
  ok: boolean;
  detail: string;
  fix: string; // åtgärdsförslag vid FAIL
}

async function runHealthChecks(env: Env): Promise<HealthResult[]> {
  const acc = CF_ACCOUNT_ID;
  const checks: { id: string; fix: string; run: () => Promise<{ ok: boolean; detail: string }> }[] = [
    {
      id: "root_200",
      fix: "Kontrollera Worker-deployen (wrangler tail politiker-webapp-app) och custom domain-routing.",
      run: async () => {
        const res = await fetchWithTimeout(`https://${POLITIKER_HOST}/`, { redirect: "manual" });
        return { ok: res.status === 200, detail: `HTTP ${res.status}` };
      },
    },
    {
      id: "api_me_json",
      fix: "API:t svarar inte med HTTP 200 + giltig JSON — kolla politiker-webapp-app-loggarna.",
      run: async () => {
        const res = await fetchWithTimeout(`https://${POLITIKER_HOST}/api/me`);
        if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
        try {
          await res.json();
          return { ok: true, detail: `HTTP ${res.status}, giltig JSON` };
        } catch {
          return { ok: false, detail: `HTTP ${res.status}, ogiltig JSON` };
        }
      },
    },
    {
      id: "domain_service",
      fix:
        "workers/domains pekar på fel Worker (känd bugg: -sender saknar fetch-handler → 500/1101). " +
        `Peka om ${POLITIKER_HOST} till politiker-webapp-app.`,
      run: async () => {
        const result = ((await cfApi(
          env.CF_READONLY_TOKEN,
          "GET",
          `/accounts/${acc}/workers/domains?domain=${POLITIKER_HOST}`
        )) ?? []) as { hostname: string; service: string }[];
        const entry = result.find((d) => d.hostname === POLITIKER_HOST);
        return {
          ok: entry?.service === "politiker-webapp-app",
          detail: entry ? `service=${entry.service}` : "ingen domain-post hittad",
        };
      },
    },
    {
      id: "scripts_exist",
      fix: "Worker-script saknas — kontrollera senaste deployen av politiker-webapp.",
      run: async () => {
        const result = ((await cfApi(env.CF_READONLY_TOKEN, "GET", `/accounts/${acc}/workers/scripts`)) ?? []) as {
          id: string;
        }[];
        const ids = result.map((s) => s.id);
        const missing = ["politiker-webapp-app", "politiker-webapp-sender"].filter((n) => !ids.includes(n));
        return { ok: missing.length === 0, detail: missing.length ? `saknas: ${missing.join(", ")}` : "båda finns" };
      },
    },
    {
      id: "d1_politicians",
      fix: "politicians-tabellen är nära tom — möjlig dataförlust, återställ från senaste D1-backup/export.",
      run: async () => {
        const result = (await cfApi(
          env.CF_READONLY_TOKEN,
          "POST",
          `/accounts/${acc}/d1/database/${POLITIKER_D1_UUID}/query`,
          { sql: "SELECT COUNT(*) as n FROM politicians" }
        )) as { results: { n: number }[] }[];
        const n = result?.[0]?.results?.[0]?.n ?? 0;
        return { ok: n >= 1000, detail: `${n} politiker` };
      },
    },
    {
      id: "access_apps",
      fix:
        "Access-konfig fel: publika sajten (roten) ska vara ogated och /admin-appen " +
        "(politiker.denied.se/admin, /admin/*, /api/admin/*) ska finnas kvar — kolla Zero Trust → Applications.",
      run: async () => {
        const result = ((await cfApi(env.CF_READONLY_TOKEN, "GET", `/accounts/${acc}/access/apps`)) ?? []) as {
          domain?: string;
          self_hosted_domains?: string[];
        }[];
        const domains = result.flatMap((a) => [a.domain ?? "", ...(a.self_hosted_domains ?? [])]);
        const rootGated = domains.some((d) => d === POLITIKER_HOST || d === `${POLITIKER_HOST}/`);
        const adminExists = domains.some((d) => d.startsWith(`${POLITIKER_HOST}/admin`));
        const problems: string[] = [];
        if (rootGated) problems.push("roten är Access-grindad (ska vara publik)");
        if (!adminExists) problems.push("/admin-appen saknas");
        return { ok: !rootGated && adminExists, detail: problems.length ? problems.join("; ") : "OK" };
      },
    },
  ];

  const results: HealthResult[] = [];
  for (const c of checks) {
    try {
      const { ok, detail } = await c.run();
      results.push({ id: c.id, ok, detail, fix: c.fix });
    } catch (e) {
      results.push({ id: c.id, ok: false, detail: `kontrollen kraschade: ${String(e).slice(0, 200)}`, fix: c.fix });
    }
  }
  return results;
}

const HEALTH_REMINDER_SECONDS = 6 * 3600;

async function processHealthResults(env: Env, results: HealthResult[]): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const failed: string[] = [];
  const recovered: string[] = [];
  const reminders: string[] = [];

  for (const r of results) {
    const prev = await env.DB.prepare(
      `SELECT ok, since, last_alert FROM healthcheck_state WHERE check_id = ?`
    )
      .bind(r.id)
      .first<{ ok: number; since: number; last_alert: number | null }>();
    const prevOk = prev ? prev.ok === 1 : true; // saknad rad = anta tidigare OK, så första FAIL larmar

    if (prevOk !== r.ok) {
      await env.DB.prepare(
        `INSERT INTO healthcheck_state (check_id, ok, since, last_alert, detail)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(check_id) DO UPDATE SET ok = excluded.ok, since = excluded.since,
           last_alert = excluded.last_alert, detail = excluded.detail`
      )
        .bind(r.id, r.ok ? 1 : 0, now, r.ok ? null : now, r.detail)
        .run();
      if (r.ok) recovered.push(`• ${r.id}: ${r.detail}`);
      else failed.push(`• ${r.id}: ${r.detail}\n  Åtgärd: ${r.fix}`);
    } else if (!r.ok && prev && (prev.last_alert === null || now - prev.last_alert >= HEALTH_REMINDER_SECONDS)) {
      await env.DB.prepare(`UPDATE healthcheck_state SET last_alert = ?, detail = ? WHERE check_id = ?`)
        .bind(now, r.detail, r.id)
        .run();
      const hours = Math.round((now - prev.since) / 3600);
      reminders.push(`• ${r.id}: fortfarande FAIL sedan ${hours}h (${r.detail})\n  Åtgärd: ${r.fix}`);
    } else if (!prev) {
      // Första körningen med OK-status — persistera utan att larma.
      await env.DB.prepare(
        `INSERT INTO healthcheck_state (check_id, ok, since, last_alert, detail) VALUES (?, 1, ?, NULL, ?)`
      )
        .bind(r.id, now, r.detail)
        .run();
    }
  }

  if (failed.length) {
    await postSlack(env, `🚨 AKUT: politiker.denied.se — ${failed.length} kontroll(er) har gått från OK till FAIL:\n${failed.join("\n")}`);
  }
  if (reminders.length) {
    await postSlack(env, `⏰ Påminnelse: politiker.denied.se har kvarstående fel:\n${reminders.join("\n")}`);
  }
  if (recovered.length) {
    await postSlack(env, `✅ Återställt: politiker.denied.se — följande kontroller är gröna igen:\n${recovered.join("\n")}`);
  }
}

async function dailyHealthSummary(env: Env): Promise<void> {
  const results = await runHealthChecks(env);
  const today = new Date().toISOString().slice(0, 10);
  const red = results.filter((r) => !r.ok);
  if (red.length === 0) {
    await postSlack(env, `✅ politiker.denied.se: alla ${results.length} kontroller OK (${today})`);
  } else {
    const lines = red.map((r) => `• ${r.id}: ${r.detail}`);
    await postSlack(
      env,
      `⚠️ politiker.denied.se daglig summering (${today}): ${red.length} av ${results.length} kontroller RÖDA:\n${lines.join("\n")}`
    );
  }
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

    async scheduled(event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
      switch (event.cron) {
        case "*/5 * * * *": // healthcheck politiker.denied.se
          await processHealthResults(env, await runHealthChecks(env));
          break;
        case "0 7 * * *": // daglig summering (läser inte state, dubbelprocessar inga transitioner)
          await dailyHealthSummary(env);
          break;
        case "0 7 * * 1": // veckovis token-underhåll
          await maintainCfTokens(env);
          break;
        default:
          console.warn("scheduled: okänt cron-uttryck:", event.cron);
      }
    },
  } satisfies ExportedHandler<Env>,
);
