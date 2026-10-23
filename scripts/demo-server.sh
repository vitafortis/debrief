#!/bin/sh
# Runs the built web app against the demo database (see packages/core/scripts/seed-demo.ts).
cd "$(dirname "$0")/../web" || exit 1
DATABASE_URL=${DATABASE_URL:-postgresql://debrief:debrief@localhost:55520/debrief_demo} \
AUTH_SECRET=${AUTH_SECRET:-demo-only-secret-not-for-production} \
DEBRIEF_PASSWORD=${DEBRIEF_PASSWORD:-demo} RECORDINGS_DIR=${RECORDINGS_DIR:-/tmp/debrief-demo-recordings} \
exec npx next start -p 3150
