#!/bin/bash
# Skickar en heartbeat till ops-hub. Kör via cron var 5:e minut på varje
# VPS/server som ska synas i /vps-status.
#
# Usage: HEARTBEAT_SECRET=... ./heartbeat.sh <source-id>
set -euo pipefail
SOURCE_ID="${1:?Usage: HEARTBEAT_SECRET=... ./heartbeat.sh <source-id>}"
OPS_HUB_URL="${OPS_HUB_URL:-https://ops-hub.<ditt-cf-konto>.workers.dev}"

CPU=$(top -bn1 | grep "Cpu(s)" | awk '{print $2}' 2>/dev/null || echo "unknown")
MEM=$(free -m | awk '/Mem:/ {printf "%.0f", $3/$2*100}' 2>/dev/null || echo "unknown")
DISK=$(df -h / | awk 'NR==2 {print $5}' 2>/dev/null || echo "unknown")

curl -fsS -X POST "$OPS_HUB_URL/webhook/heartbeat" \
  -H "Authorization: Bearer ${HEARTBEAT_SECRET:?HEARTBEAT_SECRET saknas}" \
  -H "Content-Type: application/json" \
  -d "{\"source_id\":\"$SOURCE_ID\",\"status\":\"up\",\"details\":{\"cpu_pct\":\"$CPU\",\"mem_pct\":\"$MEM\",\"disk_used\":\"$DISK\"}}"
