# ops-hub — AI Agent Guide

Central Cloudflare Worker + D1 som tar emot GitHub org-webhooks och VPS-
heartbeats, och exponerar frågeendpoints (`/coderabbit-quota`, `/vps-status`)
för realtidsbeslut istället för statiska scheman. Se `README.md` för
arkitektur och `worker/src/index.ts` för implementationen.

## Conventions

- All logik i `worker/src/index.ts` — en enda Worker, inga fler filer om det
  inte krävs (håll det enkelt, det här är infrastruktur, inte en produkt)
- D1-schema i `worker/schema.sql` — kör `npm run db:migrate:remote` efter ändring
- Nya event-källor (utöver GitHub/heartbeat) läggs till som nya `/webhook/<källa>`-
  routes, med egen signaturverifiering om leverantören stödjer det
- Hemligheter (nycklar, lösenfraser, tokens) lämnar aldrig enheten okrypterade

## Allowed
- Create branches
- Modify code
- Run tests
- Open PRs

## Forbidden
- Push directly to main/master
- Merge PRs
- Delete branches
- Disable workflows
- Modify secrets
- Change GitHub org settings

## Requirements
- All tests must pass
- Keep PRs focused
- Never include unrelated changes
- Never commit credentials
- Never force push
