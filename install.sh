#!/usr/bin/env bash
set -euo pipefail

# Distill unified installer.
# Detects installed agents and runs each one's native install path.
# Safe to re-run. Use --dry-run to preview without installing.
# Use --only <id> to install a single agent.
# Use --with-mcp-shrink to also install the distill-shrink MCP middleware globally.

DRY_RUN=false
ONLY=""
WITH_MCP_SHRINK=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --only) ;;
    --with-mcp-shrink) WITH_MCP_SHRINK=true ;;
    *)
      if [[ "${prev_arg:-}" == "--only" ]]; then
        ONLY="$arg"
      fi
      ;;
  esac
  prev_arg="$arg"
done

REPO="arzoo14/distill"

run() {
  local id="$1"
  local label="$2"
  local cmd="$3"

  if [[ -n "$ONLY" && "$ONLY" != "$id" ]]; then
    return
  fi

  echo "[$id] $label"
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  would run: $cmd"
  else
    eval "$cmd" || echo "  skipped (not detected / failed): $id"
  fi
}

echo "Distill installer"
echo "=================="

# Claude Code
if command -v claude >/dev/null 2>&1; then
  run "claude-code" "Claude Code plugin" \
    "claude plugin marketplace add ${REPO} && claude plugin install distill@distill"
fi

# Codex CLI
if command -v codex >/dev/null 2>&1 || command -v npx >/dev/null 2>&1; then
  run "codex" "Codex CLI skill" \
    "npx skills add ${REPO} -a codex"
fi

# Gemini CLI
if command -v gemini >/dev/null 2>&1; then
  run "gemini" "Gemini CLI extension" \
    "gemini extensions install distill"
fi

# Cursor / Windsurf / Cline (rule-file based, always-on)
if command -v npx >/dev/null 2>&1; then
  run "cursor" "Cursor rule file" \
    "npx skills add ${REPO} -a cursor --with-init"
  run "windsurf" "Windsurf rule file" \
    "npx skills add ${REPO} -a windsurf --with-init"
  run "cline" "Cline rule file" \
    "npx skills add ${REPO} -a cline --with-init"
fi

# Copilot (soft probe — no reliable always-on detection signal)
run "copilot" "GitHub Copilot (manual: copy SKILL.md into your Copilot instructions)" \
  "echo 'See README.md — Copilot has no CLI install path; copy SKILL.md manually.'"

# MCP middleware, opt-in
if [[ "$WITH_MCP_SHRINK" == "true" ]]; then
  if command -v npm >/dev/null 2>&1; then
    run "mcp-shrink" "distill-shrink MCP middleware (global)" \
      "npm install -g distill-shrink"
  fi
fi

echo ""
echo "Done. Run '/distill-stats' in your agent to check savings (starts at zero)."
echo "Run '/distill' to confirm adaptive mode is active."
