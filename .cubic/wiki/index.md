# blixten85/ops-hub Wiki

> This directory is machine-managed by cubic. Edit wiki content through [cubic wiki settings](https://www.cubic.dev/wiki/blixten85/ops-hub) and custom instructions.

Wiki version: 2
Source commit: 4b24d0e024a51027d22e2b37d943973b23f146aa
Source branch: main
Generated: 2026-07-20T06:11:23.496Z

## Contents

### Overview

- [Home & Overview](01-s-overview/01-home-overview.md)
- [Getting Started & Setup](01-s-overview/02-setup-guide.md)
- [Developer Conventions](01-s-overview/03-developer-conventions.md)

### System Architecture

- [High-Level Architecture](02-s-architecture/01-architecture.md)
- [Security Architecture](02-s-architecture/02-security-policy.md)

### GitHub Integrations

- [GitHub Webhook Receiver](04-s-feat-github/01-github-webhooks.md)
- [Real-time CodeRabbit Quota Tracking](04-s-feat-github/02-coderabbit-quota.md)
- [AI Triage of CodeRabbit Threads](04-s-feat-github/03-ai-triage.md)
- [Auto-Merge Arming Logic](04-s-feat-github/04-auto-merge-arming.md)

### Infrastructure & Monitoring

- [VPS Heartbeat System](05-s-feat-infra/01-vps-heartbeat.md)
- [Service Health Checks](05-s-feat-infra/02-health-checks.md)
- [Automated Token Maintenance](05-s-feat-infra/03-token-maintenance.md)
- [Slack Alerting Flow](05-s-feat-infra/04-slack-alerts.md)

### Data Management/Flow

- [D1 Database Schema](06-s-data/01-database-schema.md)

### Backend Systems

- [Worker Router & Endpoints](07-s-backend/01-api-endpoints.md)
- [Authentication & HMAC Verification](07-s-backend/02-hmac-auth.md)
- [Cron Jobs Configuration](07-s-backend/03-cron-jobs.md)

### Model Integration

- [Worker AI Integration](08-s-ai/01-worker-ai-model.md)
- [Claude App Collaboration Pattern](08-s-ai/02-claude-collaboration.md)

### Deployment/Infrastructure

- [Cloudflare Wrangler Deployment](09-s-deployment/01-deployment.md)
- [Database Migrations](09-s-deployment/02-db-migrations.md)
- [GitHub Repository Configuration](09-s-deployment/03-github-rulesets.md)
- [Troubleshooting & Caveats](09-s-deployment/04-troubleshooting.md)

### Extensibility and Customization

- [Adding New Webhook Sources](10-s-extensibility/01-extending-webhooks.md)
- [Integrating VPS Clients](10-s-extensibility/02-heartbeat-client.md)
