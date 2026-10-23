<p align="center"><img src="docs/logo.svg" width="64" height="64" alt=""></p>

<h1 align="center">Debrief</h1>

<p align="center">Self-hosted meeting transcripts with calendar context and follow-ups.<br>
No bots join your calls, and nothing leaves your network unless you send it.</p>

![Dashboard](docs/screenshots/dashboard.png)

Debrief takes the recordings your desktop already makes (Meetily, or any audio file), transcribes them on your own server with faster-whisper, works out which calendar event each one was, and gives you a searchable archive. Claude reads the meetings over MCP and pulls out the action items; you approve them and they go to Akiflow or Linear.

| | |
|---|---|
| ![A meeting](docs/screenshots/meeting.png) | ![Search](docs/screenshots/search.png) |
| **A meeting.** The event, attendees, summary and action items sit beside the transcript. The line being spoken stays highlighted; click any line to jump there. | **Search.** Full text over every meeting, showing who said each matching line and when. |
| ![Calendar](docs/screenshots/calendar.png) | ![Tasks](docs/screenshots/tasks-light.png) |
| **Calendar.** Each meeting shows whether it has been recorded, is transcribing, or is ready. | **Tasks.** Review in bulk, edit, then send to Akiflow or Linear. |

## How it fits together

```
Mac / Windows desktops                  Unraid NAS (NFS, 10GbE)              HP DL360 G9 (Docker)
──────────────────────                  ───────────────────────              ─────────────────────────────────
Meetily records system audio  ──sync──▶ /mnt/meetings/audio/<device>/… ◀──── transcriber   faster-whisper (+ pyannote)
                                        /mnt/meetings/exports/…        ◀──── (writes .txt / .json per meeting)
                                                                              postgres      local SSD only
Google Calendar / ICS feeds  ◀───────────────────────────────────────────── calendar-sync every 5 min; links transcripts
Browser (Authentik SSO)  ─────────────────────────────────────────────────▶ web           Next.js UI, streams audio
Claude (MCP, bearer token)  ──────────────────────────────────────────────▶ mcp-server    search, read, save & send tasks
                                                                                 └──▶ Akiflow (webhook) / Linear (API)
```

1. Meetily writes each meeting to its own folder (`audio.mp4` and `metadata.json`), and Syncthing or rsync copies that folder to the NAS.
2. Every 30 seconds the **transcriber** scans the recordings folder for anything new. It scans on a timer because file-change events don't fire for files written to NFS from another machine. It waits until Meetily marks the recording `completed`. A file with no `metadata.json` counts as finished once it has stopped growing for a minute.
3. faster-whisper (`large-v3`, int8 on CPU) transcribes the audio. With a Hugging Face token, pyannote also labels the speakers. The transcript goes to Postgres and an export goes to `/mnt/meetings/exports/YYYY-MM-DD/`.
4. **calendar-sync** links the new transcript to the calendar event it overlaps. The overlap is measured against the shorter of the two, and 70% is enough, so joining late or leaving early still matches. A recording that spans two back-to-back meetings links to both. Recordings that arrive before their event has synced are linked on a later sync.
5. Each calendar has a **context** (`ironclad`, `pwnbook`). It filters every page (sidebar → Calendars) and sets where that calendar's tasks go by default.
6. Claude reads a meeting through MCP and saves its action items. You review them on the meeting page or the Tasks page, then send them.

## Install

On the HP, with the NAS export mounted at `/mnt/meetings`:

```sh
mkdir debrief && cd debrief
curl -O https://raw.githubusercontent.com/vitafortis/debrief/main/compose.yaml
curl -o .env https://raw.githubusercontent.com/vitafortis/debrief/main/.env.example
mkdir secrets && touch secrets/google-creds.json   # fill in below, or leave empty for ICS-only
$EDITOR .env
docker compose up -d
```

Images are published to `ghcr.io/vitafortis/debrief-{web,calendar-sync,mcp,transcriber}`. The first transcription downloads `large-v3` (about 3 GB) into the `models` volume. On the dual Xeons, expect roughly 5–10 minutes per hour of audio.

The web container applies database migrations when it starts. The other services wait until it has.

### Recording on each desktop

1. Install [Meetily](https://github.com/Zackriya-Solutions/meetily) and leave **auto-save** on. Recordings go to `~/Movies/meetily-recordings` on a Mac and `Music\meetily-recordings` on Windows.
2. Sync that folder into a device folder on the NAS, for example `/mnt/meetings/audio/mac-work/` and `/mnt/meetings/audio/win-desktop/`. Syncthing (send-only) is the easy option; `rsync -a` from a cron job works too. The device folder name becomes the recording's device tag.
3. Any other recorder works as well. Drop `.m4a`, `.mp3`, `.wav`, `.ogg`, `.flac` or `.webm` files anywhere under `audio/`. A timestamp in the name (`2026-10-22 14.03 Standup.m4a`) is read in `TZ`. Without one, the start time is the file's modified time minus its length.

### Sign-in (Authentik)

In Authentik, create an **OAuth2/OpenID provider** and an application for it:

- **Redirect URI:** `https://debrief.armgrp.dev/api/auth/callback/oidc`
- **Scopes:** `openid email profile`

Then set `AUTH_OIDC_ISSUER` (the provider's issuer URL, ending in `/application/o/<slug>/`), `AUTH_OIDC_ID` and `AUTH_OIDC_SECRET`. `ALLOWED_EMAILS` optionally limits who can get in.

There are two other modes. `DEBRIEF_PASSWORD` gives you one password instead. `AUTH_MODE=none` turns sign-in off, for when Authentik forward-auth already guards the route; don't publish the port if you use it.

### Calendars

Add calendars under **Settings → Calendars**, or list them in `.env`:

```sh
GOOGLE_CALENDARS=ironclad:you@ironclad.example,pwnbook:primary
ICS_CALENDARS=personal:https://outlook.office365.com/owa/calendar/…/calendar.ics
```

For Google, put one of these at `secrets/google-creds.json`:

- **A service account key.** Create one in Google Cloud with the Calendar API enabled. Then share each calendar with the service account's address ("See all event details").
- **An OAuth `authorized_user` file** with a refresh token, for example from `gcloud auth application-default login --scopes=https://www.googleapis.com/auth/calendar.readonly`. It can read everything the account can.

If a work calendar can't be shared outside the company, use its secret iCal address as an ICS feed instead.

### Where tasks go

- **Akiflow** has no public API. Make a Zapier, Make or IFTTT webhook whose action is "Create task in Akiflow", and put its URL in `AKIFLOW_WEBHOOK_URL`.
  - Debrief posts `{title, date, duration, priority, due_date, description, context, uniqueIdentifier}`.
  - `uniqueIdentifier` is `debrief-<meeting>-<item>`, so a retried send can be de-duplicated.
- **Linear:** set `LINEAR_API_KEY`, plus either `LINEAR_TEAM` (a team key like `ENG`) or `LINEAR_TEAMS=ironclad:ENG,pwnbook:PWN` to pick the team by context.

### Claude (MCP)

The MCP server runs at `https://debrief.armgrp.dev/mcp`. It sits on the same host as the app but on its own Traefik route, without SSO, and authenticates with `MCP_TOKEN`. In Claude Code:

```sh
claude mcp add --transport http debrief https://debrief.armgrp.dev/mcp --header "Authorization: Bearer $MCP_TOKEN"
```

Its tools:

| Tool | What it does |
|---|---|
| `search_transcripts` | Searches across meetings; returns the matching lines with who said them and when |
| `list_recent_meetings` | Lists the last few days' meetings with their summaries and open tasks |
| `get_transcript` | Returns a whole transcript |
| `get_meeting_context` | Returns the meeting's event, attendees, summary and tasks, plus the transcript |
| `extract_tasks` | Gives Claude the transcript with instructions for finding action items |
| `save_tasks` | Saves the items Claude found (and a summary) for you to review |
| `list_tasks` | Lists tasks |
| `update_task` | Edits, approves or dismisses a task |
| `push_task` | Sends a task to Akiflow or Linear |
| `create_linear_issue` | Creates a Linear issue directly |

Try asking Claude: *"Extract the action items from today's standup in Debrief."*

There's also an optional **Extract with Claude** button on each meeting page. It needs `ANTHROPIC_API_KEY` and calls the Claude API directly.

### A GPU later

A low-profile Tesla T4 brings an hour of audio down to about 2–5 minutes. To use one:

1. Set `WHISPER_DEVICE=cuda`.
2. Give the transcriber the GPU (`deploy.resources.reservations.devices` in compose, plus the NVIDIA container toolkit on the host).
3. Run a CUDA build of the image, which needs a CUDA 12 / cuDNN 9 base in place of `python:3.12-slim`. That build isn't published yet.

## Configuration

Everything is set through environment variables; [`.env.example`](.env.example) lists them. A few others:

| Variable | Service | Default | |
|---|---|---|---|
| `WHISPER_MODEL` | transcriber | `large-v3` | Any faster-whisper model (`medium`, `distil-large-v3`, …) |
| `LANGUAGE` | transcriber | auto | Force a language, e.g. `en` |
| `SCAN_INTERVAL` | transcriber | `30` | Seconds between scans of the recordings folder |
| `DIARIZE` | transcriber | on with `HF_TOKEN` | Speaker labels with `pyannote/speaker-diarization-community-1` (accept its terms on Hugging Face first) |
| `SYNC_DAYS_BACK` / `SYNC_DAYS_AHEAD` | calendar-sync | `30` / `14` | The window of events kept in sync |
| `MATCH_THRESHOLD` | calendar-sync | `0.7` | How much overlap counts as a match |
| `ANTHROPIC_MODEL` | web | `claude-sonnet-5-5` | For the Extract button |

## Development

You need Node 24, pnpm, Python 3.12 with [uv](https://docs.astral.sh/uv/), and Docker for Postgres.

```sh
docker run -d --name debrief-db -e POSTGRES_USER=debrief -e POSTGRES_PASSWORD=debrief -e POSTGRES_DB=debrief -p 127.0.0.1:55520:5432 postgres:16-alpine
pnpm install
DATABASE_URL=postgresql://debrief:debrief@localhost:55520/debrief pnpm db:migrate

# Made-up demo data (every person and company in it is invented)
docker exec debrief-db createdb -U debrief debrief_demo
DATABASE_URL=postgresql://debrief:debrief@localhost:55520/debrief_demo pnpm --filter @debrief/core exec tsx scripts/seed-demo.ts
pnpm --filter web build && scripts/demo-server.sh          # http://localhost:3150, password "demo"
node scripts/screenshots.mjs                               # refreshes docs/screenshots

# Tests
TEST_DATABASE_URL=postgresql://debrief:debrief@localhost:55520/debrief_test pnpm --filter @debrief/core test
pnpm --filter web test:e2e                                 # Playwright, seeds debrief_e2e
cd transcriber && uv venv && uv pip install -e . pytest && .venv/bin/pytest
```

| Path | |
|---|---|
| `packages/core` | Schema and migrations (Drizzle), calendar sync, matching, search, tasks and integrations, shared by every Node service |
| `web` | The UI: Next.js 16 with the ·modern theme in emerald (Geist, sidebar shell, raised buttons) |
| `services/calendar-sync` | The calendar poller; also listens for new transcripts (`pg_notify`) |
| `services/mcp` | The MCP server (streamable HTTP, stateless) |
| `transcriber` | Python: folder scanner, faster-whisper, pyannote |

## License

[Apache-2.0](LICENSE)
