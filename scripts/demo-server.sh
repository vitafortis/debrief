#!/bin/sh
# Runs the built web app against the demo database (see packages/core/scripts/seed-demo.ts).
cd "$(dirname "$0")/../web" || exit 1
DATABASE_URL=${DATABASE_URL:-postgresql://debrief:debrief@localhost:55520/debrief_demo} \
AUTH_SECRET=${AUTH_SECRET:-demo-only-secret-not-for-production} \
DEBRIEF_PASSWORD=${DEBRIEF_PASSWORD:-demo} OWNER_NAME=${OWNER_NAME:-Nathan} TZ=${TZ:-America/New_York} \
PUBLIC_URL=http://localhost:3150 AUDIO_DIR=${AUDIO_DIR:-/tmp/debrief-demo-audio} \
exec npx next start -p 3150
