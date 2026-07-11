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

## Varför inget CodeRabbit-eget API används

Undersökt 2026-07-11: CodeRabbit exponerar inget utgående webhook eller API
för granskningsstatus/kö/kvot (deras "webhooks"-funktion är för att DE ska
ta emot händelser från GitLab/Bitbucket, inte tvärtom). Lösningen ovan
approximerar kvotanvändning genom att räkna GitHub-händelser som sannolikt
triggar en granskning (`pull_request.opened/synchronize/reopened`,
`@coderabbitai review`-kommentarer) — samma signal CodeRabbit själv agerar
på, bara observerad från utsidan via GitHub istället för CodeRabbit direkt.
Kvotgränsen (5/timme, Pro-plan, kontogemensam) är hårdkodad i
`handleCodeRabbitQuota` — uppdatera om planen ändras.

Granskningens FÄRDIGSTATUS (klar/inte klar) är däremot direkt observerbar
via GitHub: CodeRabbit postar en vanlig `check_run` med namnet `CodeRabbit`
på varje PR, som redan fångas av `/webhook/github` (event-typ
`check_run.completed` m.fl.) — ingen approximation behövs där.

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
