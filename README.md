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

## Arkitektur

Byggt genom att klona [`repo-standard`](https://github.com/blixten85/repo-standard)
som bas (guldstandard-filer/workflows) och lägga till projektspecifik kod
ovanpå — samma mönster andra kan följa för nya projekt.

```
worker/
  src/index.ts    — hela Workern: webhook-mottagning + frågeendpoints
  schema.sql      — D1-schema (events + heartbeats)
  wrangler.jsonc  — Cloudflare-konfig
clients/
  heartbeat.sh    — exempel-klient att köra via cron på en VPS
```

### Endpoints

| Metod + path | Syfte | Auth |
|---|---|---|
| `POST /webhook/github` | Tar emot GitHub org-webhooken (PR-events, m.fl.) | HMAC-SHA256-signatur (`X-Hub-Signature-256`) |
| `POST /webhook/heartbeat` | VPS/tjänst postar sin status | `Authorization: Bearer <HEARTBEAT_SECRET>` |
| `GET /coderabbit-quota` | Rullande 60-min-räkning av granskningstriggrande händelser | ingen (internt bruk — lägg bakom Access om det exponeras publikt) |
| `GET /vps-status` | Senast kända status per källa | ingen (samma som ovan) |

## Setup

1. `cd worker && npm install`
2. `wrangler d1 create ops-hub-db` — klistra in `database_id` i `wrangler.jsonc`
3. `npm run db:migrate:remote`
4. `wrangler secret put GITHUB_WEBHOOK_SECRET` — valfri sträng, samma används i steg 6
5. `wrangler secret put HEARTBEAT_SECRET` — valfri sträng, delas till VPS:arna
6. `npm run deploy`
7. Skapa en **organisationswebhook** på `github.com/organizations/blixten85/settings/hooks`:
   - Payload URL: `https://ops-hub.<konto>.workers.dev/webhook/github`
   - Content type: `application/json`
   - Secret: samma som steg 4
   - Events: minst `Pull requests`, `Issue comments`, `Check runs`
8. På varje VPS (t.ex. mp100), lägg till en cron-rad:
   ```
   */5 * * * * HEARTBEAT_SECRET=... OPS_HUB_URL=https://ops-hub.<konto>.workers.dev /path/to/clients/heartbeat.sh mp100
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
