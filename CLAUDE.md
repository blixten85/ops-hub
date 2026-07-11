# ops-hub — Claude Code Guide

Central Cloudflare Worker + D1 för webhooks/notiser (GitHub PR-events,
CodeRabbit-granskningsspårning, VPS-heartbeats). Se `README.md`.

## Conventions

- All logik i `worker/src/index.ts`, D1-schema i `worker/schema.sql`
- Nya event-källor läggs till som nya `/webhook/<källa>`-routes
