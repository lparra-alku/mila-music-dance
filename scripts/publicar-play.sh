#!/bin/sh
# Publica la app web en play.musicdance.app (Cloudflare Pages, proyecto musicdance-play).
set -e
cd "$(dirname "$0")/.."
DIST=$(mktemp -d)
mkdir -p "$DIST/store"
cp index.html lame.min.js "$DIST/"
cp store/privacidad.html "$DIST/store/"
cd "$DIST"   # fuera de worker/ para que wrangler no tome la configuración del Worker
"$OLDPWD/worker/node_modules/.bin/wrangler" pages deploy "$DIST" --project-name musicdance-play --branch main --commit-dirty=true --force
rm -rf "$DIST"
