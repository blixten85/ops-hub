#!/bin/bash
# Applicerar branch-ruleset-template.json på ett nytt repo. Kör själv (inte via
# agent) — branch-protection-ändringar via API är avsiktligt blockerade för
# agenter i den här organisationen (CI Bypass-kategori, se AGENTS.md).
#
# Usage: ./apply-ruleset.sh <repo-namn>
set -euo pipefail
REPO="${1:?Usage: ./apply-ruleset.sh <repo-namn>}"
gh api --method POST "repos/blixten85/$REPO/rulesets" --input "$(dirname "$0")/branch-ruleset-template.json"
echo "Ruleset applicerat på blixten85/$REPO."
echo "OBS: lägg till repo-specifika CI-jobbnamn i required_status_checks manuellt"
echo "(t.ex. 'lint', 'test', 'typecheck') — den här mallen har bara CodeRabbit."
