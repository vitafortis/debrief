<p align="center"><img src="docs/logo.svg" width="64" height="64" alt=""></p>

<h1 align="center">Debrief</h1>

<p align="center">Self-hosted meeting transcripts with calendar context and follow-ups.<br>
No bots join your calls, and nothing leaves your network unless you send it.<br>
<a href="https://vitafortis.github.io/debrief/">Website and docs</a></p>

![Dashboard](docs/screenshots/dashboard.png)

The Debrief Recorder on your Mac or PC notices when a meeting app takes the microphone, records the call (asking first, or not, per app) and streams it to your server, from home or anywhere else. Debrief transcribes it with faster-whisper, works out which calendar event it was, has Claude write a summary and pull out the action items, posts them to Slack, and keeps a searchable archive with the full audio on your NAS. You approve the action items and they go to Akiflow or Linear. Meetily, or any audio file synced to the NAS, works too.

| | |
|---|---|
| ![A meeting](docs/screenshots/meeting.png) | ![Search](docs/screenshots/search.png) |
| **A meeting.** The event, attendees, summary and action items sit beside the transcript. The line being spoken stays highlighted; click any line to jump there. | **Search.** Full text over every meeting, showing who said each matching line and when. |
| ![Calendar](docs/screenshots/calendar.png) | ![Tasks](docs/screenshots/tasks-light.png) |
| **Calendar.** Each meeting shows whether it has been recorded, is transcribing, or is ready. | **Tasks.** Review in bulk, edit, then send to Akiflow or Linear. |

**Contents**
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Getting started](#getting-started)
- [Using Debrief](#using-debrief)
- [The recorder](#the-recorder)
- [Connecting Claude](#connecting-claude)
- [Updating and backups](#updating-and-backups)
- [Troubleshooting](#troubleshooting)
- [Configuration reference](#configuration-reference)
- [Development](#development)

## How it works

```
Mac / Windows desktops                     NAS (NFS)                            Server (Docker)
──────────────────────                     ─────────                            ─────────────────────────────────
Debrief Recorder ──HTTPS, API key──────────────────────────────────────────────▶ web           upload API, the UI, audio
                                           /mnt/meetings/audio/<device>/… ◀──── (writes uploads here)
Meetily (optional) ──Syncthing / rsync───▶ /mnt/meetings/audio/<device>/… ◀──── transcriber   faster-whisper (+ pyannote)
                                           /mnt/meetings/exports/<day>/…  ◀──── .txt / .json per meeting
                                                                         ◀──── calendar-sync .notes.md: summary, tasks, transcript
                                                                                 postgres      on the server's local disk
Google Calendar / ICS feeds  ◀──────────────────────────────────────────────── calendar-sync links meetings, has Claude summarize
Slack (incoming webhook)     ◀──────────────────────────────────────────────── calendar-sync summary + action items
Claude (MCP, API key)       ──────────────────────────────────────────────────▶ mcp-server    search, read, save & send tasks
                                                                                    └──▶ Akiflow (webhook) / Linear (API)
```

1. **Recording.** The Debrief Recorder runs in the menu bar (Mac) or tray (Windows). When an app takes the microphone, it asks whether to record, records straight away, or ignores it, depending on that app's rule. It records your microphone and the computer's audio (the other side of the call), so nothing joins the call.
2. **Streaming up.** The recording goes to Debrief in chunks while the meeting runs, through your reverse proxy with an API key, so it works away from home too. It's written to disk first: if the connection drops, recording carries on and the upload resumes where it stopped. The server writes it into the recordings folder on the NAS (`audio/<device>/<start>_<id>/audio.opus`), where the full audio stays, so a meeting can always be replayed or transcribed again.
3. **Transcribing.** Every 30 seconds the **transcriber** scans the recordings folder. It picks up a recording once it's finished: the recorder (or Meetily) marks it `completed`, or a plain file stops growing for a minute. faster-whisper transcribes it; with a Hugging Face token, pyannote also labels who is speaking. The transcript goes to Postgres, with a copy in `exports/YYYY-MM-DD/` as `.txt` and `.json`.
4. **Matching.** **calendar-sync** links each new transcript to the calendar event it overlaps. Overlap is measured against the shorter of the two and 70% is enough, so joining late or leaving early still matches; a recording that spans two back-to-back meetings links to both.
5. **Contexts.** Each calendar has a **context**, such as `ironclad` for work and `pwnbook` for the side project. It filters every page and sets where that calendar's tasks go by default. A meeting with no calendar event can take its context from the device it was recorded on, if you set one for that device.
6. **Summary and action items.** With an Anthropic API key, Claude summarizes each new meeting and pulls out its action items as soon as it's matched. (Or ask Claude to, through MCP.) The summary, action items and transcript are written to `exports/` as a `.notes.md`, and posted to Slack.
7. **Follow-up.** You review the action items in Debrief, then send them to Akiflow or Linear.

## Requirements

### Server

| | Minimum | Recommended |
|---|---|---|
| CPU | 4 cores, x86-64 | 16+ cores (e.g. dual Xeon); transcription is CPU-bound |
| Memory | 8 GB | 16 GB+ (`large-v3` takes about 4 GB, speaker labels about 2 GB more) |
| Disk (local) | 15 GB | SSD: images (about 4 GB), Whisper model (3 GB), Postgres |
| GPU | — | Optional; see [A GPU later](#a-gpu-later) |
| Software | Docker Engine 24+ with Compose v2 | Traefik for HTTPS |

Rough speed for `large-v3` on CPU: 5–10 minutes per hour of audio on a dual Xeon, and 20–40 minutes on a 4-core box. Smaller models (`medium`, `distil-large-v3`) are 2–4× faster and a little less accurate.

### Storage

- **A NAS share mounted on the server at `/mnt/meetings`**, with `audio/` and `exports/` inside. NFS or SMB both work. (Different paths: set `AUDIO_PATH` and `EXPORTS_PATH`.)
  - `audio/` keeps every recording in full: about 21 MB per hour from the Debrief Recorder, 50–100 MB from Meetily.
  - `exports/` gets each meeting's transcript (`.txt`, `.json`) and notes (`.notes.md`: summary, action items, transcript).
  - A fast link (10 GbE, or even 1 GbE) only affects how quickly a new file is picked up.
- **Postgres stays on the server's own disk** (a Docker volume). Don't put it on the NAS: its write-ahead log isn't safe over network filesystems.

### Desktops

- **The Debrief Recorder** (in this repo): macOS 14.2 or later, or Windows 10/11. It needs to reach Debrief over HTTPS (your reverse proxy) or on the LAN.
- Or [Meetily](https://github.com/Zackriya-Solutions/meetily) (or any recorder that saves audio files) plus [Syncthing](https://syncthing.net/) or rsync to copy them to the NAS.

### Accounts and services

| | Needed for | Required? |
|---|---|---|
| A sign-in method | Getting into the UI | Yes: Authentik (or any OpenID Connect provider), or a single password |
| A domain + Traefik | HTTPS, and Claude reaching the MCP server | Recommended; plain ports work on a LAN |
| Google Cloud project, or an ICS feed URL | Calendar matching | Recommended; without a calendar, meetings are still transcribed but don't get titles or attendees |
| Hugging Face account | Speaker labels | Optional |
| Zapier, Make or IFTTT | Sending tasks to Akiflow | Optional |
| Linear API key | Sending tasks to Linear | Optional |
| Claude (Code, Desktop or claude.ai) | Reading meetings and extracting tasks | Optional, and the main point |
| Anthropic API key | Summarizing every meeting and finding its action items automatically | Optional; without it, ask Claude through MCP |
| Slack incoming webhook | The summary and action items in a channel | Optional |

## Getting started

The examples use the setup Debrief was built for: an Unraid NAS, an HP server running Docker with Traefik, Authentik for sign-in, and `debrief.armgrp.dev` as the address. Swap in your own.

### 1. Share a folder from the NAS

1. On Unraid, create a share called `meetings` and turn on **NFS export** for it (Shares → meetings → NFS Security Settings → Export: Yes). Limit it to the server's IP with a rule such as `192.168.1.20(rw,sec=sys,no_root_squash)`.
2. Inside the share, create `audio/` and `exports/`.

Unraid shares belong to `nobody:users` (uid 99, gid 100). Note those numbers; the transcriber runs as that user in step 4.

### 2. Mount it on the server

```sh
sudo mkdir -p /mnt/meetings
echo 'nas.lan:/mnt/user/meetings  /mnt/meetings  nfs  rw,hard,noatime,vers=4.2,_netdev  0 0' | sudo tee -a /etc/fstab
sudo mount /mnt/meetings
ls /mnt/meetings        # audio  exports
```

### 3. Download Debrief

```sh
mkdir -p ~/debrief/secrets && cd ~/debrief
curl -fsSLO https://raw.githubusercontent.com/vitafortis/debrief/main/compose.yaml
curl -fsSL -o .env https://raw.githubusercontent.com/vitafortis/debrief/main/.env.example
touch secrets/google-creds.json      # filled in at step 6; empty is fine for ICS-only
```

### 4. Fill in `.env`

Generate the secrets:

```sh
echo "DB_PASSWORD=$(openssl rand -hex 16)"
echo "AUTH_SECRET=$(openssl rand -base64 32)"
```

Then edit `.env`:

| Setting | Value |
|---|---|
| `DB_PASSWORD`, `AUTH_SECRET` | The values generated above |
| `DEBRIEF_HOST` | The hostname Traefik serves Debrief on, e.g. `debrief.armgrp.dev` |
| `TZ` | Your time zone, e.g. `America/New_York`. Meetings are shown in it, and it's used to read timestamps in file names |
| `MEETINGS_UID` / `MEETINGS_GID` | The share's owner: `99` / `100` on Unraid. The transcriber, web (which writes uploads) and calendar-sync (which writes notes) run as this user |
| `AUDIO_PATH` / `EXPORTS_PATH` | Only if the share isn't at `/mnt/meetings/audio` and `/mnt/meetings/exports` on the server |
| `OWNER_NAME` | Your name, as shown in the sidebar |

The rest (sign-in, calendars, task destinations, Slack) is covered in the next steps. API keys for the recorder and Claude are made in the app, after it's running.

**Traefik.** `compose.yaml` expects an external Docker network called `traefik` and an entrypoint called `websecure`. Rename them in the labels if yours differ.

**Without Traefik.** `compose.standalone.yaml` drops the Traefik network and labels and publishes `web` on port 3000 and `mcp-server` on 3001. Download it next to `compose.yaml` and add two lines to `.env`:

```sh
curl -fsSLO https://raw.githubusercontent.com/vitafortis/debrief/main/compose.standalone.yaml
```

```sh
COMPOSE_FILE=compose.yaml:compose.standalone.yaml
DEBRIEF_URL=http://192.168.1.20:3000     # the address you browse to
```

Plain `docker compose` then uses both files. Put an HTTPS proxy in front before opening it beyond your LAN.

### 5. Set up sign-in

**With Authentik (recommended).**

1. In Authentik, open **Applications → Providers → Create** and make an *OAuth2/OpenID Provider*:
   - **Client type:** Confidential
   - **Redirect URIs:** `https://debrief.armgrp.dev/api/auth/callback/oidc`
   - **Scopes:** the default `openid`, `email` and `profile` mappings
2. Create an **Application** that uses this provider, with the slug `debrief`, and grant access to your user or group.
3. In `.env`, set:

   ```sh
   AUTH_OIDC_ISSUER=https://auth.armgrp.dev/application/o/debrief/
   AUTH_OIDC_ID=<client id>
   AUTH_OIDC_SECRET=<client secret>
   ALLOWED_EMAILS=you@example.com     # optional: only these addresses get in
   AUTH_OIDC_NAME=Authentik           # optional: the button label
   ```

**With a single password.** Leave the `AUTH_OIDC_*` settings empty and set `DEBRIEF_PASSWORD`.

**Behind Authentik forward auth.** If a Traefik middleware already guards the route, set `AUTH_MODE=none` and add the middleware to the `web` router's labels. Never publish port 3000 directly in this mode.

### 6. Connect your calendars

You can do this now or later in **Settings → Calendars**. Each calendar gets a **context**: one short word, like `ironclad` or `pwnbook`.

**Google Calendar.** Use either a service account or your own account.

- **A service account.** Best for a server.
  1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the **Google Calendar API**.
  2. Go to **IAM & Admin → Service Accounts → Create**, then **Keys → Add key → JSON**. Save the file as `secrets/google-creds.json`.
  3. In Google Calendar, open each calendar's **Settings → Share with specific people** and add the service account's address with **See all event details**.
  4. List the calendars in `.env` as `context:calendar-id`. The calendar ID is under **Integrate calendar**; for your main calendar it's your email address.

     ```sh
     GOOGLE_CALENDARS=ironclad:you@ironclad.example,pwnbook:you@gmail.com
     ```

- **Your own Google account.** This can read every calendar you can see.
  1. Run `gcloud auth application-default login --scopes=https://www.googleapis.com/auth/calendar.readonly,https://www.googleapis.com/auth/cloud-platform`.
  2. Copy `~/.config/gcloud/application_default_credentials.json` to `secrets/google-creds.json`.
  3. Your calendars then appear in Settings. Your main calendar is on; the rest start switched off. Turn on the ones you want and give each a context.

**An ICS feed** (Outlook, iCloud, or a Google calendar you can't share). Copy the calendar's secret iCal / ICS link and add it:

```sh
ICS_CALENDARS=ironclad:https://outlook.office365.com/owa/calendar/…/calendar.ics
```

### 7. Turn on speaker labels (optional)

1. Create a free [Hugging Face](https://huggingface.co/join) account.
2. Accept the terms on [pyannote/speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1).
3. Create a **Read** token under Settings → Access Tokens and set `HF_TOKEN=hf_…` in `.env`.

Without it, transcripts work the same but every line is unattributed.

### 8. Choose where tasks and notes go (optional)

- **Akiflow** has no public API, so Debrief posts each task to a webhook and an automation creates it.
  1. In Zapier (or Make, or IFTTT), create a Zap with a **Webhooks by Zapier → Catch Hook** trigger and an **Akiflow → Create Task** action.
  2. Map `title`, `description`, `date`, `due_date`, `duration` and `priority` from the hook.
  3. Put the hook URL in `AKIFLOW_WEBHOOK_URL`.

  Each task arrives as:

  ```json
  {
    "title": "Follow up with Sarah on API timeline",
    "date": "2026-10-23",
    "duration": 30,
    "priority": "high",
    "due_date": "2026-10-25",
    "description": "From Standup 10/22 — Sarah mentioned API v2 timeline may slip\nhttps://debrief.armgrp.dev/meetings/…?t=125",
    "context": "ironclad",
    "uniqueIdentifier": "debrief-<meeting id>-1"
  }
  ```

- **Linear.**
  1. Create a personal API key under Settings → Security & access and set `LINEAR_API_KEY`.
  2. Set `LINEAR_TEAM` to a team key (e.g. `ENG`), or `LINEAR_TEAMS=ironclad:ENG,pwnbook:PWN` to pick the team by context.

Each calendar has a default destination (Settings → Calendars → *Tasks go to*), and you can change it on any task.

- **Automatic summaries.** Set `ANTHROPIC_API_KEY`. Each new meeting is then summarized, and its action items found, as soon as it's transcribed and matched to its event (`AUTO_EXTRACT=false` to only do it from the button on a meeting). `ANTHROPIC_MODEL` picks the model.
- **Slack.**
  1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps) (*From scratch*), open **Incoming Webhooks**, turn them on, and **Add New Webhook to Workspace** for the channel you want.
  2. Set `SLACK_WEBHOOK_URL=https://hooks.slack.com/services/…`. For a channel per context, use `SLACK_WEBHOOKS=ironclad:https://hooks.slack.com/…,pwnbook:https://hooks.slack.com/…` (a context without one falls back to `SLACK_WEBHOOK_URL`).

  Once a meeting has its summary, Slack gets the title, time, length and attendees, the summary, and every action item with its details, owner, due date, priority, destination and a link to the moment it was said. Each meeting is posted once; **Slack → Send again** on a meeting page posts it again.

### 9. Start it

```sh
docker compose up -d
docker compose ps                 # all five services should be running
docker compose logs -f web        # "Migrations applied.", then "Ready"
```

Open `https://debrief.armgrp.dev` and sign in. Then check **Settings → Services**:

- **Calendar sync** shows when it last synced, or the error from Google.
- **Claude in the app** and **Slack** show whether they're set up.
- **Transcriber** will say nothing has been transcribed yet. That's expected.

The first recording downloads the Whisper model (about 3 GB) into the `models` volume, so it takes a few extra minutes.

To test the whole pipeline without Meetily, copy any recording into the share:

```sh
mkdir -p /mnt/meetings/audio/test
cp ~/some-call.m4a "/mnt/meetings/audio/test/$(date '+%Y-%m-%d %H.%M') Test call.m4a"
docker compose logs -f transcriber   # "New recording", "Transcribing…", "Done"
```

### 10. Set up recording on each desktop

**With the Debrief Recorder (recommended).**

1. In Debrief, open **Settings → API keys** and create a key for this computer (e.g. *Work MacBook*). Copy it; it's shown once.
2. Download the recorder from the [Recorder workflow's latest run](https://github.com/vitafortis/debrief/actions/workflows/recorder.yml) (*debrief-recorder-macOS* or *-Windows*), or from a `recorder-v*` release.
   - **Mac:** open the `.dmg` and drag **Debrief Recorder** to Applications. It isn't signed yet, so the first time, right-click it → **Open** → **Open**. (If macOS still refuses: `xattr -dr com.apple.quarantine "/Applications/Debrief Recorder.app"`.)
   - **Windows:** run the installer. SmartScreen warns about an unsigned app: **More info → Run anyway**.
3. It opens its Settings window the first time (later: the waveform icon in the menu bar or tray → **Settings…**):
   - **Server:** `https://debrief.armgrp.dev`. Optionally a **fallback server** for when the first can't be reached, such as `http://192.168.1.20:3000` at home.
   - **API key:** the one from step 1.
   - **This computer's name:** how it shows up in Debrief (defaults to the computer's name).
   - **Test connection**, then **Save**.
4. Allow the permissions it asks for the first time it records:
   - **Mac:** *Microphone*, and *System Audio Recording* (System Settings → Privacy & Security → Screen & System Audio Recording → Debrief Recorder). Without the second, only your side of the call is recorded; the recorder warns you if that happens.
   - **Windows:** microphone access for desktop apps (Settings → Privacy & security → Microphone).
5. **Record a test call.** Join any call, answer **Record** in the popup, and hang up. A minute or two later it's on the dashboard: *Queued*, then *Transcribing*, then *Ready*.

From outside your network the recorder only needs your reverse proxy to pass `https://debrief.armgrp.dev/api/recorder/…` to the `web` container, which the Traefik labels in `compose.yaml` already do. Those routes check the API key themselves, so they work with sign-in on. If a forward-auth middleware (Authentik outpost) guards the whole host, exempt `PathPrefix(`/api/recorder`)` and `PathPrefix(`/mcp`)` from it.

**With Meetily and Syncthing instead.**

1. **Install Meetily** from its [releases page](https://github.com/Zackriya-Solutions/meetily/releases).
   - On a Mac, allow **Microphone** and **Screen & System Audio Recording** when asked (System Settings → Privacy & Security). Without the second one, the other people on the call aren't recorded.
   - In Meetily's settings, keep **auto-save recordings** on.
   - Recordings go to `~/Movies/meetily-recordings` on a Mac and `%USERPROFILE%\Music\meetily-recordings` on Windows.
2. **Sync that folder to the NAS** with Syncthing (Unraid has a Syncthing app; on Windows, SyncTrayzor works well):
   - On the desktop, share `meetily-recordings` as **Send Only**.
   - On the NAS, accept it into `/mnt/user/meetings/audio/<device>`, for example `audio/mac-work` and `audio/win-desktop`. The folder name becomes the recording's **device** in Debrief.
   - Add `.checkpoints` to the folder's ignore patterns. Meetily writes 30-second chunks there while recording, and Debrief skips them anyway.

   Or use rsync from cron or launchd: `rsync -a --exclude .checkpoints ~/Movies/meetily-recordings/ nas:/mnt/user/meetings/audio/mac-work/`.

**Other recorders.** Put audio files (`.m4a`, `.mp3`, `.wav`, `.mp4`, `.ogg`, `.opus`, `.flac`, `.webm`) anywhere under `audio/<device>/`.

- A timestamp in the file name (`2026-10-22 14.03 Standup.m4a` or `20261022_140300.wav`) is read as the start time, in `TZ`.
- Otherwise the start time is worked out from the file's modified time and length. That works as long as your sync tool keeps modified times (Syncthing and `rsync -a` do).

## Using Debrief

### Day to day

1. **Take the call.** The recorder asks (or just starts, by your rules) when the meeting app takes the microphone, and stops when the app lets go. Nothing joins the call.
2. **Read the summary in Slack**, or open the dashboard. It shows:
   - today's meetings and whether each was recorded;
   - what's still transcribing, with progress;
   - the action items waiting for your review.
3. **Get the action items.** With `ANTHROPIC_API_KEY` they're already there. Otherwise ask Claude *"Extract the action items from today's standup in Debrief"* (see [Connecting Claude](#connecting-claude)).
4. **Review and send them** on the Tasks page (below).

### The sidebar and calendar filter

Under **Calendars** in the sidebar, pick a context (e.g. *Ironclad*) to narrow every page to it: the dashboard, meetings, calendar, search and tasks. **All** shows everything. The choice is remembered. Press **⌘B** (Ctrl+B) to collapse the sidebar; the sun and moon button switches between light and dark.

### A meeting

Open one from the dashboard, **Meetings** or the **Calendar**.

**Playing and reading:**
- **Player:** play/pause with the button or the space bar. **J** and **L** skip 10 seconds, the arrow buttons skip 15, and you can change the speed or click the waveform to jump.
- **Transcript:** click any line to play from there. **Follow** keeps the line being spoken in view; scrolling turns it off.
- **Find in transcript:** marks every match. Press Enter (or Shift+Enter) to step through them.

**Fixing the details:**
- **Title:** click it to rename the meeting. Leave it empty to use the calendar event's title.
- **Calendar event:** if the time matching picked the wrong event, or nothing, choose the right one from the events around that time. *Match automatically* goes back to matching by time.
- **Speakers:** with speaker labels on, the transcript says *Speaker 1*, *Speaker 2* and so on. Type names under **Speakers** and they're used everywhere: the transcript, search, exports and what Claude reads.
- **Summary:** Claude writes one when it extracts tasks. Click it to edit, or write your own.

**Action items:** shown for this meeting. Add one by hand with **Add**.

**Export:** **Markdown** downloads the summary, action items and transcript with speakers and times. **Text** is the bare transcript. The same Markdown is saved to the NAS (`exports/<day>/<title>-<id>.notes.md`) whenever the summary changes. **Slack** posts the summary and action items (again).

**Re-transcribing:** **Transcribe again** (under *Recording*) queues the file again, for example after turning on speaker labels or changing the model. Its tasks and your edits to the title, summary and speaker names are kept. Check the speaker names afterwards, since a new pass can number the speakers differently.

### Tasks

The Tasks page groups action items by meeting, newest first, across four tabs:

| Tab | What's there |
|---|---|
| **To review** | New items from Claude, waiting for you |
| **Approved** | OK'd but not sent yet |
| **Sent** | In Akiflow or Linear (Linear items link to the issue) |
| **Dismissed** | Items you don't want; **Restore** brings one back |

- **Edit:** click a task's text to change it, its owner, due date, priority, or where it goes (Akiflow or Linear).
- **Send:** sends one task now. **Approve** marks it OK without sending.
- **Select several** with the checkboxes, then **Approve**, **Approve & send** or **Dismiss** them together.
- **Jump to the moment:** the time link on a task (`@ 2:05`) opens the meeting at the moment it was said.
- **Sent tasks are never sent twice.** Asking Claude to extract tasks again only replaces items still waiting for review.

### Search

Search covers every transcript, plus meeting titles and summaries.

- Plain words match any form of the word: *timeline* also finds *timelines*.
- `"exact phrase"` matches a phrase, `-word` excludes a word, and `or` gives alternatives.
- Narrow by date with **From** and **To**, or by context with the sidebar.

Each result shows the matching lines with the speaker and time. Click one to open the meeting at that moment, with your words already marked.

### Calendar

The week and day views show your synced events. Each one carries a status:

| Dot | Meaning |
|---|---|
| Green | Transcript ready; click to open it |
| Teal, pulsing | Transcribing now |
| Amber | Recorded and queued |
| Red | Transcription failed (see the dashboard queue for the error) |
| Grey | No recording |

Use the arrows and **Today** to move around, and click a day's header for the day view.

### Settings

- **Calendars:**
  - **Add** a calendar: Google calendar ID or ICS link, plus a context.
  - **Switch one off:** its events disappear from Debrief.
  - **Rename a context.**
  - **Set where its tasks go.**
  - **Sync now:** the regular sync runs every 5 minutes.
- **Devices:** every computer recordings have come from (the recorder's name, or the Syncthing folder). Nothing is tagged by device until you pick a context for one here. A device's context is only used for meetings without a calendar event; the event's calendar always wins. *Tasks go to* sets those meetings' default destination.
- **API keys:** create one per recorder and per Claude client, so one can be revoked alone. A key is shown once; Debrief keeps only its hash. Revoking it signs that recorder or client out at once.
- **Services:** the transcriber's queue, the last calendar sync, which integrations are set up (Akiflow, Linear, Claude, Slack), and the sign-in mode.

## The recorder

| | |
|---|---|
| <img src="docs/screenshots/recorder.png" width="380" alt="The recorder's settings"> | <img src="docs/screenshots/recorder-prompt.png" width="380" alt="Record this meeting?"><br><br>**The popup** when an app with an *Ask* rule takes the microphone.<br><br>**Settings:** the live recording with levels for both sides, what's uploaded, the server and key, the rules per app, and audio and storage options. |

**The menu.** Click the waveform icon in the menu bar (Mac) or tray (Windows). It shows whether it's recording and for how long, and whether everything is uploaded. From the menu you can start or stop a recording by hand, open Debrief, show the recordings folder, open Settings, or quit. While recording, the icon turns red.

**When an app takes the microphone,** the recorder follows that app's rule:

| Rule | What happens |
|---|---|
| **Ask** | A small popup in the top right: *Zoom is using your microphone. Record this meeting?* Choose **Record** (optionally naming it), **Not now**, **Always record Zoom** or **Never for Zoom**. Unanswered, it goes away after a minute, as *Not now*. |
| **Always record** | Recording starts straight away. |
| **Never** | Nothing happens. |

- Rules match the app's name or bundle id, ignoring case: `zoom` matches `zoom.us`. The defaults are *Ask* for Zoom, Teams, Webex, Slack and FaceTime, and *Never* for Discord.
- **Any other app** has its own setting. Set it to *Record* to record everything except your *Never* list.
- Browser calls (Google Meet) show up as the browser, e.g. *Google Chrome*.
- Settings lists the apps using the microphone right now; click one to add a rule for it.
- A recording started for an app stops when that app has let go of the microphone for 45 seconds (adjustable). One started by hand runs until you stop it.
- *Not now* holds until that app lets go of the microphone; the next call asks again.

**What's recorded.** Your microphone on the left channel and the computer's audio (everyone else) on the right, as Opus at 48 kbit/s: about 21 MB an hour. Pick a microphone in Settings, or turn off the computer's audio.

**Uploading.** Audio goes up about every 20 seconds while recording, so Debrief has nearly all of it when you hang up. The recording is always written to disk first. With no connection (a plane, a hotel, the server down), it keeps recording and uploads later, retrying with backoff; Settings and the menu show what's waiting and why. Uploads resume exactly where they stopped. A recording the app was quit or crashed in the middle of is uploaded as far as it got; one that never finishes uploading (the laptop died) is transcribed anyway after `ABANDON_HOURS` (12).

**Copies on the computer.** Recordings stay in the recordings folder (Settings → *On this computer*) for 14 days after they're uploaded, then they're deleted; 0 deletes them as soon as Debrief has them. The NAS keeps the original.

**Settings** are stored in `~/Library/Application Support/dev.armgrp.debrief.recorder/settings.json` (Mac) or `%APPDATA%\dev.armgrp.debrief.recorder\settings.json` (Windows), readable only by you, API key included. Logs are in `~/Library/Logs/dev.armgrp.debrief.recorder/` or `%LOCALAPPDATA%\dev.armgrp.debrief.recorder\logs\`.

## Connecting Claude

The MCP server runs at `https://debrief.armgrp.dev/mcp`. It sits on the same host as the app but on its own Traefik route without SSO, and authenticates every request with a bearer token: an API key from **Settings → API keys** (make one per Claude client), or `MCP_TOKEN` if you set one.

**Claude Code:**

```sh
claude mcp add --transport http debrief https://debrief.armgrp.dev/mcp \
  --header "Authorization: Bearer <API key>"
```

**Claude Desktop.** Add this to `claude_desktop_config.json` (Settings → Developer → Edit Config) and restart Claude:

```json
{
  "mcpServers": {
    "debrief": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://debrief.armgrp.dev/mcp", "--header", "Authorization: Bearer <API key>"]
    }
  }
}
```

**Things to ask:**
- *"What did I agree to do in meetings this week?"*
- *"Extract the action items from the Northwind onboarding call and save them."*
- *"Search my meetings for anything about the API v2 timeline."*
- *"Send the approved pwnbook tasks to Linear."*

**Tools:**

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

Claude only saves tasks for review. Nothing goes to Akiflow or Linear unless you send it, or ask Claude to.

## Updating and backups

**Update.** The images are rebuilt on every change to `main`:

```sh
cd ~/debrief && docker compose pull && docker compose up -d
```

Database changes apply automatically when `web` starts. To stay on a specific build, set `DEBRIEF_TAG` in `.env` to one of the image tags (e.g. `0.1.42`).

**Back up the database:**

```sh
docker compose exec -T postgres pg_dump -U debrief -Fc debrief > debrief-$(date +%F).dump
# restore into a fresh stack:
docker compose exec -T postgres pg_restore -U debrief -d debrief --clean < debrief-2026-10-22.dump
```

The recordings and exports live on the NAS, so back that share up as usual. The `models` volume can always be downloaded again.

## Troubleshooting

| What you see | What to check |
|---|---|
| A recording never shows up | `docker compose logs transcriber`. Is the file under `/mnt/meetings/audio` on the server (`ls`)? A Meetily recording is picked up only once its `metadata.json` says `completed`; other files once they've stopped growing for a minute. |
| Stuck on *Queued* | Only one recording is transcribed at a time, newest first. Check the transcriber log for progress, and the dashboard queue for errors. |
| *Failed* with "Permission denied" | The transcriber can't write to `exports/`. Set `MEETINGS_UID`/`MEETINGS_GID` to the share's owner (`99`/`100` on Unraid). |
| "The audio couldn't be loaded" on a meeting | The `web` container needs `/mnt/meetings/audio` mounted (it is in `compose.yaml`) and readable by `MEETINGS_UID`. |
| The recorder says "Can't reach Debrief" | **Test connection** in its Settings says why. From outside, `https://<host>/api/recorder/ping` must reach the `web` container, not a sign-in page (exempt `/api/recorder` from forward auth). |
| The recorder says the API key is unknown | It was revoked, or mistyped. Make a new one in Settings → API keys. |
| Uploads fail with "Permission denied" | `web` writes uploads into `audio/` as `MEETINGS_UID`/`MEETINGS_GID`; set them to the share's owner. |
| Only my side of the call was recorded | Mac: allow Debrief Recorder under Privacy & Security → Screen & System Audio Recording, and check *Record the computer's audio too* is on. |
| The popup never appears | Settings → *When an app uses the microphone* must be on, and the app's rule must be *Ask*. Settings lists the apps it sees using the microphone; if yours isn't there while in a call, check the app has microphone access. |
| No Slack message | `SLACK_WEBHOOK_URL` must be set on calendar-sync (it's in the shared settings in `compose.yaml`). `docker compose logs calendar-sync` shows "sent to Slack" or Slack's error. Messages go out once a meeting has a summary. |
| A meeting has no calendar event | Is the calendar synced (Settings → Calendars shows the last sync or an error)? Is `TZ` right? A recording needs to overlap an event by 70%. Pick the event by hand on the meeting page if needed. |
| Calendar error "Not Found" or 403 | The service account hasn't been given access to that calendar, or the calendar ID is wrong. |
| No speaker names, only lines | `HF_TOKEN` isn't set, or the pyannote model's terms weren't accepted (the transcriber log says "Speaker labels are off: …"). Then press **Transcribe again**. |
| **Send** is greyed out | That destination isn't set up (`AKIFLOW_WEBHOOK_URL` or `LINEAR_API_KEY` on `web` and `mcp-server`). |
| Sign-in loops or says "didn't finish" | `AUTH_URL` must be the address you browse to, and Authentik's redirect URI must be exactly `https://<host>/api/auth/callback/oidc`. |
| Claude gets 401 | The `Authorization: Bearer` header must be an API key from Settings (or `MCP_TOKEN`). |

## Configuration reference

Everything is set through environment variables in `.env`; [`.env.example`](.env.example) lists the main ones. A few more:

| Variable | Service | Default | |
|---|---|---|---|
| `WHISPER_MODEL` | transcriber | `large-v3` | Any faster-whisper model: `medium`, `distil-large-v3`, `small.en`… |
| `WHISPER_DEVICE` | transcriber | `cpu` | `cuda` with a GPU (see below) |
| `COMPUTE_TYPE` | transcriber | `int8` on CPU, `float16` on GPU | |
| `CPU_THREADS` | transcriber | all cores | Limit to leave room for other containers |
| `LANGUAGE` | transcriber | auto | Force a language, e.g. `en` |
| `BEAM_SIZE` | transcriber | `5` | Lower is faster, higher a little more accurate |
| `SCAN_INTERVAL` | transcriber | `30` | Seconds between scans of the recordings folder |
| `STABLE_SECONDS` | transcriber | `60` | How long a file without `metadata.json` must stop changing |
| `ABANDON_HOURS` | transcriber | `12` | A recording still marked as in progress is transcribed anyway once it hasn't changed for this long |
| `AUDIO_PATH` / `EXPORTS_PATH` | compose | `/mnt/meetings/audio` / `…/exports` | Where on the server the recordings and notes live |
| `AUTO_EXTRACT` | calendar-sync | `true` | Summarize each new meeting when `ANTHROPIC_API_KEY` is set |
| `SLACK_WEBHOOK_URL` / `SLACK_WEBHOOKS` | calendar-sync, web | — | Slack incoming webhook, or one per context (`ironclad:https://…,pwnbook:https://…`) |
| `MCP_TOKEN` | mcp-server | — | An extra fixed bearer token for Claude, besides the API keys made in Settings |
| `DIARIZE` | transcriber | on when `HF_TOKEN` is set | Speaker labels on or off |
| `SYNC_DAYS_BACK` / `SYNC_DAYS_AHEAD` | calendar-sync | `30` / `14` | The window of events kept in sync |
| `POLL_INTERVAL_SECONDS` | calendar-sync | `300` | |
| `MATCH_THRESHOLD` | calendar-sync | `0.7` | How much overlap counts as a match |
| `AUTH_MODE` | web | `oidc` if `AUTH_OIDC_ISSUER` is set, else `password` | `none` turns sign-in off (only behind forward auth) |
| `ANTHROPIC_MODEL` | web, calendar-sync | `claude-sonnet-5-5` | For summaries and the Extract button |
| `AKIFLOW_DEFAULT_DURATION` | web, mcp | `30` | Minutes, for the Akiflow payload |

### A GPU later

A low-profile Tesla T4 brings an hour of audio down to about 2–5 minutes. To use one:

1. Install the NVIDIA driver and the NVIDIA Container Toolkit on the host.
2. Give the transcriber the GPU in `compose.yaml`:

   ```yaml
   deploy:
     resources:
       reservations:
         devices: [{ driver: nvidia, count: 1, capabilities: [gpu] }]
   ```
3. Set `WHISPER_DEVICE=cuda`.
4. Run a CUDA build of the transcriber image, built from an `nvidia/cuda:12-cudnn9-runtime` base instead of `python:3.12-slim`. That build isn't published yet.

## Development

You need Node 24, pnpm 9, Python 3.12 with [uv](https://docs.astral.sh/uv/), and Docker for Postgres.

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

# The recorder (Rust + Tauri 2; needs CMake for libopus)
cd recorder && pnpm install --ignore-workspace
pnpm tauri dev                                             # runs it from source
pnpm tauri build                                           # .app / .dmg, or the Windows installer
cd src-tauri && cargo test                                 # mixing, resampling, Ogg Opus, rules
cargo run --example smoke -- 10 http://localhost:3150 <API key>   # record 10 s and upload it
```

| Path | |
|---|---|
| `packages/core` | Schema and migrations (Drizzle), calendar sync, matching, search, tasks and integrations, shared by every Node service |
| `web` | The UI: Next.js 16 with the ·modern theme in teal |
| `services/calendar-sync` | The calendar poller; on `pg_notify` it links new transcripts, has Claude summarize them, writes the notes file and posts to Slack |
| `services/mcp` | The MCP server (streamable HTTP, stateless) |
| `transcriber` | Python: folder scanner, faster-whisper, pyannote |
| `recorder` | The Debrief Recorder: Tauri 2 tray app in Rust. Meeting detection, capture (cpal, a Core Audio process tap on macOS, WASAPI loopback on Windows), Ogg Opus, resumable upload |

## License

[Apache-2.0](LICENSE)
