# ops-hub

Central nod för webhooks/notiser från GitHub, VPS:ar och (framöver) fler
leverantörer. Löser två saker som ett statiskt schema aldrig kan:

1. **Realtids-CodeRabbit-kvot** — istället för att gissa ett säkert
   tidsfönster (se `repo-standard`s staggerschema) räknar denna nod
   faktiska granskningstriggrande GitHub-händelser i ett rullande
   60-minutersfönster. `GET /coderabbit-quota` svarar `safe_to_trigger_now`
   direkt, så en agent (eller ett skript) kan fråga "får jag pusha/trigga
   en granskning just nu?" istället för att vänta på ett fönster som
   kanske inte ens behövs den dagen (lite/inga dependency-uppdateringar).
2. **VPS/tjänst-status** — `POST /webhook/heartbeat` tar emot pingar från
   mp100 och andra servrar (cron, delad hemlighet). `GET /vps-status`
   visar senast sedd status per källa — grund för att senare koppla in
   riktiga ner/upp-notiser (t.ex. till Slack via Resend/webhook).
3. **Auto-merge-armare** — webhook-driven ersättare för en timer-baserad
   molnrutin. Vid `pull_request` (opened/synchronize/reopened/
   ready_for_review) och `check_run` (completed, conclusion
   success/skipped) kollas berörda öppna PR:er i `blixten85`-repon: är
   PR:en öppen, inte draft, utan auto-merge och CLEAN (eller MERGEABLE
   utan failing/pending checks) armas GitHubs nativa auto-merge (squash)
   via GraphQL. Mutationerna är auto-merge-flaggan (metadata-only,
   triggar ingen CodeRabbit-granskning) samt — enbart när GitHub vägrar
   arma en redan-CLEAN PR ("Pull request is in clean status", annars
   fastnar den för alltid eftersom inga fler events kommer) — en vanlig
   squash-merge, paritet med gamla rutinens `gh pr merge --auto`. Aldrig
   kommentarer, pushar, force-merge eller branch protection-ändringar.
   BLOCKED/failing/konflikt skippas tyst; utfall loggas som
   `automerge.armed` respektive `automerge.merged_direct` i
   `events`-tabellen. Kräver secreten `GITHUB_TOKEN` (PAT, repo-scope).
4. **Healthcheck politiker.denied.se** (cron var 5:e min) — sex kontroller:
   roten svarar 200, `/api/me` ger giltig JSON, workers/domains pekar på
   `politiker-webapp-app` (känd historisk bugg: pekade på `-sender` som
   saknar fetch-handler → 500/1101), båda Worker-scripten finns,
   `politicians`-tabellen i D1 har tusentals rader (nära noll =
   dataförlust), samt Access-konfigen (publik rot ogated, /admin-appen
   kvar). Status persisteras i `healthcheck_state`; Slack ENDAST vid
   transition OK→FAIL (urgent, med åtgärdsförslag per kontroll) och
   FAIL→OK (återställt), plus max en påminnelse per 6h vid kvarstående
   fel. Daglig 07:00-summering ("✅ alla 6 kontroller OK" eller vad som
   är rött). Kräver secreten `CF_READONLY_TOKEN`.
5. **Token-underhåll** (cron måndagar 07:00) — förvaltar tre Cloudflare
   account-tokens (admin/deploy/readonly): saknas `expires_on` eller
   ligger den < 30 dagar bort sätts den till exakt 1 år framåt via PUT
   (med befintlig `policies`-array oförändrad — annars strippas
   åtkomsten tyst; datummönstret `expires YYYY-MM-DD` i namnet
   uppdateras). Rör ALDRIG mp100-serverns token, DELETE:ar aldrig.
   Postar alltid exakt ett Slack-meddelande med resultatet. Från
   2026-09-07 inkluderas dessutom en varning om att repo-secreten
   `GH_TOKEN` (fine-grained PAT, politiker-webapp, utgår ~2026-09-21)
   måste förnyas manuellt av en människa. Kräver secreten
   `CF_ADMIN_TOKEN`.

6. **Olösta CodeRabbit-review-trådar** — vid `pull_request_review_thread`
   med `action: "unresolved"` (GitHubs event har bara actions `resolved`/
   `unresolved` — INTE `created`, verifierat mot octokit/webhooks-schemat)
   där trådens första kommentar är skriven av `coderabbitai`/`coderabbitai[bot]`
   postas en kort Slack-notis med PR-länk. Detta täcker fallet där
   rulesetets `required_review_thread_resolution` faktiskt blockerar merge
   och ett mänskligt beslut krävs (åtgärda fyndet eller markera löst).
   Debounce i D1 (`notified_threads`-tabellen): högst en notis per
   repo+PR var 30:e minut, så flera olösta trådar på samma PR inte
   spammar Slack. Kräver att webhooken per repo abonnerar på händelsen
   "Pull request review threads" (utöver de i steg 8 nedan) samt
   `SLACK_BOT_TOKEN`/`SLACK_WEBHOOK_URL`.

Slack-notiser går via `SLACK_BOT_TOKEN` (chat.postMessage) med
`SLACK_WEBHOOK_URL` som fallback; saknas båda loggas de bara i Workern
(Slack-helpern kastar aldrig, övrig logik överlever alltid).

7. **Slack → GitHub-relä (tråd-repl blir en `@claude`-kommentar)** — `POST
   /webhook/slack` tar emot Slacks Events API (`message`/`app_mention`).
   Svarar Slacks `url_verification`-handskakning direkt. Verifierar
   `X-Slack-Signature`/`X-Slack-Request-Timestamp` mot `SLACK_SIGNING_SECRET`
   (samma HMAC-mönster som GitHub-webhooken, fast Slacks `v0:{ts}:{body}`-
   variant) och avvisar (401) ogiltig signatur eller >5 min gammal timestamp
   (replay-skydd). Ett svar i tråden på en notis från punkt 6 ovan (matchat
   via `notified_threads.slack_thread_ts`, satt när notisen postades) blir en
   `@claude <text>`-kommentar på rätt PR — ren transport, ingen egen
   AI-logik i ops-hub. **SÄKERHETSSPÄRR (medveten, inte en TODO): endast
   Slack-användaren `U0BBTRUBHEK` (operatören) är allowlistad för
   vidarebefordran.** Meddelanden från alla andra användare (och alla
   bot-meddelanden) ignoreras tyst — 200 till Slack, inget svar som
   avslöjar att kollen finns, bara en `console.warn`-logg internt. Detta
   stänger en tidigare identifierad brist: utan kollen skulle vem som helst
   som kan skriva i kanalen kunna trigga en autonom kodändringspipeline mot
   GitHub. Kräver secreten `SLACK_SIGNING_SECRET` samt `SLACK_BOT_TOKEN`
   (chat.postMessage — ger `ts` tillbaka, krävs för trådkoppling;
   `SLACK_WEBHOOK_URL` räcker inte, den ger ingen `ts`).

## Arkitektur

Byggt genom att klona [`repo-standard`](https://github.com/blixten85/repo-standard)
som bas (guldstandard-filer/workflows) och lägga till projektspecifik kod
ovanpå — samma mönster andra kan följa för nya projekt.

```
worker/
  src/index.ts    — hela Workern: webhook-mottagning + frågeendpoints + cron-handlers
  schema.sql      — D1-schema (events + heartbeats + healthcheck_state + notified_threads)
  wrangler.jsonc  — Cloudflare-konfig
clients/
  heartbeat.sh    — exempel-klient att köra via cron på en VPS
```

### Endpoints

| Metod + path | Syfte | Auth |
|---|---|---|
| `POST /webhook/github` | Tar emot GitHub org-webhooken (PR-events, m.fl.) | HMAC-SHA256-signatur (`X-Hub-Signature-256`) |
| `POST /webhook/heartbeat` | VPS/tjänst postar sin status | `Authorization: Bearer <HEARTBEAT_SECRET>` |
| `POST /webhook/slack` | Slack Events API — tråd-repl från en allowlistad användare vidarebefordras som `@claude`-kommentar | `X-Slack-Signature`/`X-Slack-Request-Timestamp` mot `SLACK_SIGNING_SECRET` |
| `GET /coderabbit-quota` | Rullande 60-min-räkning av granskningstriggrande händelser | `Authorization: Bearer <QUERY_SECRET>` |
| `GET /vps-status` | Senast kända status per källa | `Authorization: Bearer <QUERY_SECRET>` |

## Setup

1. `cd worker && npm install`
2. `wrangler d1 create ops-hub-db` — klistra in `database_id` i `wrangler.jsonc`
3. `npm run db:migrate:remote`
4. `wrangler secret put GITHUB_WEBHOOK_SECRET` — valfri sträng, samma används i steg 7
5. `wrangler secret put HEARTBEAT_SECRET` — valfri sträng, delas till VPS:arna
6. `wrangler secret put QUERY_SECRET` — valfri sträng, delas till allt som ska läsa `/coderabbit-quota` eller `/vps-status`
6b. `wrangler secret put GITHUB_TOKEN` — PAT med repo-scope, används av auto-merge-armaren
6c. `wrangler secret put CF_ADMIN_TOKEN` — Cloudflare account-token med token-läs/skriv, för veckovisa token-underhållet
6d. `wrangler secret put CF_READONLY_TOKEN` — Cloudflare readonly-token (Workers/D1/Access läs), för healthchecken
6e. `wrangler secret put SLACK_BOT_TOKEN` (eller `SLACK_WEBHOOK_URL`) — valfritt men krävs för att Slack-notiserna ska nå fram
6f. `wrangler secret put SLACK_SIGNING_SECRET` — Slack-appens Signing Secret (Basic Information-sidan), krävs för `/webhook/slack`. I Slack-appens Event Subscriptions, sätt Request URL till `https://ops-hub.denied.se/webhook/slack` och prenumerera på `message.channels`/`app_mention` för samma kanal som notiserna postas till. **OBS: endast Slack-användaren `U0BBTRUBHEK` är allowlistad för vidarebefordran till GitHub — en medveten säkerhetsspärr, se punkt 7 nedan.**
7. Sätt `routes: [{ pattern: "ops-hub.<din-zon>", custom_domain: true }]` i `wrangler.jsonc` — **inte** `workers.dev`, den delade domänen blockeras av Cloudflares eget bot-skydd på kanten (bekräftat 2026-07-11, requesten når aldrig Workerns kod). `npm run deploy`.
8. `blixten85` är ett **personkonto**, inte en Organization — GitHub stödjer inga konto-breda webhooks för personkonton. Skapa en webhook **per repo** istället (loop över `gh api repos/{owner}/{repo}/hooks -X POST ...`):
   - Payload URL: `https://ops-hub.<din-zon>/webhook/github`
   - Content type: `application/json`
   - Secret: samma som steg 4
   - Events: minst `Pull requests`, `Issue comments`, `Check runs`,
     `Pull request review threads` (för olösta CodeRabbit-fynd-notiser)
9. På varje VPS (t.ex. mp100), lägg till en cron-rad:
   ```
   */5 * * * * HEARTBEAT_SECRET=$(cat /path/to/secret) OPS_HUB_URL=https://ops-hub.<din-zon> /path/to/clients/heartbeat.sh mp100
   ```

## CodeRabbits eget API — rättad förståelse (2026-07-11)

**Tidigare fel i denna README:** vi trodde inledningsvis att CodeRabbit
saknade ett API helt. Det stämmer inte. CodeRabbit har ett dokumenterat
REST-API:

```
GET https://api.coderabbit.ai/v1/metrics/reviews?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
Header: x-coderabbitai-api-key: cr-xxxxxxxxxx
```

- Parametrar: `organization_ids`, `repository_ids`, `user_ids` (kommaseparerat,
  max 10 st), `format=json|csv`, `limit` (default 1000), `cursor` (paginering)
- Svar per PR: `pr_url`, `created_at`, `ready_for_review_at`,
  `first_human_review_at`, `last_commit_at`, `merged_at`, `author_*`,
  `organization_*`, `repository_*`, `estimated_complexity` (1–5),
  `estimated_review_minutes`, samt `coderabbit_comments` uppdelat på
  **allvarlighetsgrad** (critical/major/minor/trivial/info) och
  **kategori** (security_and_privacy, performance_and_scalability,
  functional_correctness, maintainability_and_code_quality,
  data_integrity_and_integration, stability_and_availability) — vardera
  med posted/accepted-antal.
- Rate limit på API:et självt: **10 requests/min** (`X-RateLimit-*`-headers).
- Dokumenterat som **Enterprise-only** — men vi fick ändå ut denna exakta
  datastruktur (bekräftat via en användaruppladdad CSV som matchar schemat
  fält för fält) på ett Pro-konto, troligen via en export-knapp på
  dashboardens "Summary"-sida snarare än den råa API-nyckeln. Overifierat
  om Pro-planen ger API-nyckelåtkomst också — testa genom att skapa en
  nyckel i dashboarden och köra ett anrop.

**Vad detta INTE ger:** ingen realtidsstatus för pågående/köade
granskningar — bara historik för MERGADE PR:er, retroaktivt. Bekräftat i
CodeRabbits egen dokumentation ("no in-progress or queued review
endpoints exist"). Vår ursprungliga lösning (räkna GitHub-händelser som
sannolikt triggar en granskning, i ett rullande 60-min-fönster) är alltså
FORTFARANDE nödvändig för `/coderabbit-quota` — CodeRabbits eget API kan
inte ersätta den, bara komplettera med rikare efterhandsstatistik.

**Möjlig utökning:** en periodisk cron-jobb (t.ex. dagligen) som hämtar
`/v1/metrics/reviews` för föregående dygn och skriver in i en ny D1-tabell
(`coderabbit_review_stats`) skulle ge oss exakta siffror på faktisk
kommentarvolym/allvarlighetsgrad per repo över tid — användbart för att
t.ex. se vilka repon som genererar flest kritiska fynd, eller om ett
repos PR:er systematiskt dröjer länge innan första granskning (ett tecken
på att de träffar rate-limit-kön, vilket redan setts i verklig data: en
`bastion`-PR hade ~15 timmar mellan `created_at` och `first_human_review_at`
under den period stagger-schemat saknades). INTE implementerat än — kräver
en API-nyckel skapad manuellt i CodeRabbit-dashboarden (agenten har inte
den åtkomsten).

Granskningens FÄRDIGSTATUS (klar/inte klar) för en SPECIFIK, aktuell PR är
enklast observerad via GitHub direkt: CodeRabbit postar en vanlig
`check_run` med namnet `CodeRabbit` på varje PR, som redan fångas av
`/webhook/github` (event-typ `check_run.completed` m.fl.) — ingen
CodeRabbit-API-nyckel behövs för det.

## Utökning till fler leverantörer

Nod-mönstret (webhook in → D1 → frågeendpoint) är generellt. Naturliga
nästa steg om det blir aktuellt:

- **Hostup** — VPS-övervakning (CPU/RAM/disk/underhåll/omstarter,
  fakturagräns). Hostups API-nyckel gav bara läsrättigheter mot
  `hosting-accounts` (tom lista) i tidigare undersökning — okänt om deras
  dashboard kan konfigureras att POST:a webhooks hit; kräver inloggning i
  webbgränssnittet för att verifiera (agenten har inte den åtkomsten).
- **GitHub Actions-status org-brett** — redan delvis täckt via
  `check_run`-events i `/webhook/github`.
- **MacinCloud, Codex, Anthropic** — inga kända webhook-mekanismer hittade
  vid undersökning 2026-07-11. Anthropics egen statussida
  (status.anthropic.com) har ingen dokumenterad webhook-export; skulle
  kräva periodisk polling istället för push om det ska in i denna nod.
