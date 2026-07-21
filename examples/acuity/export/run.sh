#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v bun >/dev/null 2>&1; then
  echo "This bundle needs Bun. Install it, then re-run:" >&2
  echo "  curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi

# Install external dependencies once (no-op if the node code uses only the standard library).
if [ ! -f .mill-installed ]; then
  echo "mill: installing dependencies…" >&2
  bun install
  touch .mill-installed
fi

# Run: no args → first workflow (batch); "<workflow> '<json>'" → that workflow; "serve [port]" → HTTP API.
exec bun run index.js "$@"
