# Debrief

- `web` is Next.js 16: APIs and conventions differ from older versions (`proxy.ts`, async `params`). Read `web/node_modules/next/dist/docs/` before writing Next code.
- Shared logic lives in `packages/core` and is used by web, calendar-sync and mcp. The Python transcriber writes the same tables with plain SQL, so schema changes must keep `transcriber/debrief_transcriber/main.py` in step.
- After changing `packages/core/src/schema.ts`, run `pnpm db:generate` and commit the migration.
- Checks: `pnpm -r check`, `pnpm --filter web lint`, core tests (`TEST_DATABASE_URL=…`), `pnpm --filter web test:e2e`, `transcriber/.venv/bin/pytest`.
- Demo data and screenshots: see README → Development. Demo data must stay fictional.
