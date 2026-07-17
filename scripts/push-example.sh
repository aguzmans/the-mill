#!/usr/bin/env bash
# Seed your (empty) GitHub repo with the demo project so Mill can reconcile + run it.
# Create the repo on GitHub WITHOUT a README (truly empty), then:
#   scripts/push-example.sh https://github.com/you/your-repo.git <TOKEN> [branch]
set -euo pipefail
REPO="${1:?usage: push-example.sh <https-repo-url> <token> [branch]}"
TOKEN="${2:?token required}"
BRANCH="${3:-main}"

AUTH="$(printf '%s' "$REPO" | sed "s#https://#https://x-access-token:${TOKEN}@#")"
TMP="$(mktemp -d)"
for d in examples/*/; do
  [ -f "${d}project.yaml" ] || continue
  cp -r "$d" "$TMP/$(basename "$d")"
done
cd "$TMP"
git init -q -b "$BRANCH"
git -c user.email=you@mill.dev -c user.name=you add -A
git -c user.email=you@mill.dev -c user.name=you commit -qm "seed: billing project (folder-per-project)"
git remote add origin "$AUTH"
git push -q -u origin "$BRANCH"
echo "✓ pushed examples/billing → ${REPO} (${BRANCH})"
echo "  now set PROJECT_REPO/GIT_TOKEN in .env and: docker compose up -d api"
