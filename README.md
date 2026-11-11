<p align="center"><img src="docs/logo.svg" width="64" height="64" alt=""></p>

<h1 align="center">Debrief</h1>

<p align="center">Self-hosted meeting transcripts with calendar context and follow-ups.<br>
No bots join your calls, and nothing leaves your network unless you send it.<br>
<a href="https://vitafortis.github.io/debrief/">Website and docs</a></p>

![Dashboard](docs/screenshots/dashboard.png)

The Debrief Recorder on your Mac or PC notices when a meeting app takes the microphone, records the call (asking first, or not, per app) and streams it to your server, from home or anywhere else. Debrief transcribes it with faster-whisper, works out which calendar event it was, has Claude write a summary and pull out the action items, posts them to Slack, and keeps a searchable archive, with the full audio on the server, your NAS or S3. You approve the action items and they go to Akiflow or Linear. Meetily, or any audio file synced to a NAS folder, works too.

| | |
|---|---|
| ![A recording](docs/screenshots/meeting.png) | ![Search](docs/screenshots/search.png) |
| **A recording.** The event, attendees, summary and action items sit beside the transcript. The line being spoken stays highlighted; click any line to jump there. | **Search.** Full text over every recording, showing who said each matching line and when. |
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
Mac / Windows desktops                Server (Docker)                              Archive (optional)
──────────────────────                ───────────────────────────────────────      ──────────────────
Debrief Recorder ──HTTPS, API key───▶ web            the UI, upload API, audio
                                        └─▶ recordings volume ──────────────────▶ NAS folder or S3
                                      transcriber    faster-whisper (+ pyannote)
                                      calendar-sync  calendars, summaries, archiving
                                      mcp-server     for Claude
                                      postgres       on the server's own disk
Meetily (optional) ──Syncthing──────▶ NAS folder ◀── transcriber watches it (optional)

Google Calendar / ICS feeds ◀──────── calendar-sync links meetings, has Claude summarize
Slack (incoming webhook)    ◀──────── calendar-sync posts the summary and action items
Claude (MCP, API key)       ────────▶ mcp-server    search, read, save & send tasks ──▶ Akiflow / Linear
```

1. **Recording.** The Debrief Recorder runs in the menu bar (Mac) or tray (Windows). When an app takes the microphone, it asks whether to record, records straight away, or ignores it, depending on that app's rule. It records your microphone and the computer's audio (the other side of the call), so nothing joins the call.
2. **Streaming up.** The recording goes to Debrief in chunks while the meeting runs, with an API key, so it works away from home too. It's written to disk first: if the connection drops, recording carries on and the upload resumes where it stopped. The server keeps it in its recordings volume.
3. **Transcribing.** As soon as the upload finishes, the **transcriber** picks it up. faster-whisper transcribes it. A Debrief Recorder recording keeps your microphone and the call on separate channels, so each side is transcribed on its own: your lines are marked as yours, overlaps included, and anything from the call that your microphone picked up (on speakers rather than headphones) is left out. With a Hugging Face token, pyannote also tells apart the people on the call. The transcript goes to Postgres.
4. **Matching.** **calendar-sync** links each new transcript to the calendar event it overlaps. Overlap is measured against the shorter of the two and 70% is enough, so joining late or leaving early still matches; a recording that spans two back-to-back meetings links to both.
5. **Contexts.** Each calendar has a **context**, a short word such as `work` or `side`. It filters every page and sets where that calendar's tasks go by default. A meeting with no calendar event can take its context from the device it was recorded on, if you set one for that device.
6. **Summary and action items.** With an Anthropic API key, Claude summarizes each new meeting and pulls out its action items as soon as it's matched. (Or ask Claude to, through MCP.) The summary and action items are posted to Slack.
7. **Archiving.** Once transcribed, the recording is copied to your NAS folder or an S3 bucket, if you choose one, and the server's copy is removed a week later (both adjustable). Meetings play from wherever the audio is.
8. **Follow-up.** You review the action items in Debrief, then send them to Akiflow or Linear.

## Requirements

### Server

| | Minimum | Recommended |
|---|---|---|
| CPU | 4 cores, x86-64 | 16+ cores; transcription is CPU-bound |
| Memory | 8 GB | 16 GB+ (`large-v3` takes about 4 GB, speaker labels about 2 GB more) |
| Disk | 15 GB | SSD: images (about 4 GB), Whisper model (3 GB), Postgres, and recordings until they're archived (about 21 MB an hour) |
| GPU | — | Optional; see [A GPU later](#a-gpu-later) |
| Software | Docker Engine 24+ with Compose 2.24+ | A reverse proxy for HTTPS (Traefik is built in) |

Rough speed for `large-v3` on CPU: 5–10 minutes per hour of audio on a 16-core server, and 20–40 minutes on a 4-core box. Smaller models (`medium`, `distil-large-v3`) are 2–4× faster and a little less accurate.

### Storage

Nothing beyond the server is required: recordings stay in a Docker volume. For more room or a second copy, Debrief can archive them:

- **A NAS folder**, mounted on the server (NFS or SMB). It also takes a copy of each transcript (`.txt`, `.json`) and the meeting notes (`.notes.md`), and is where Meetily or Syncthing recordings go to be picked up. See [Archive to a NAS](#archive-to-a-nas).
- **S3-compatible storage**: AWS S3, Cloudflare R2, Backblaze B2, Wasabi, or MinIO on your NAS.

Keep Postgres on the server's own disk (the compose file does). Its write-ahead log isn't safe over network filesystems.

### Desktops

- **The Debrief Recorder** (in this repo): macOS 14.2 or later, or Windows 10/11. It needs to reach Debrief over HTTPS, or on the LAN.
- Or [Meetily](https://github.com/Zackriya-Solutions/meetily) (or any recorder that saves audio files) plus [Syncthing](https://syncthing.net/) or rsync to copy them to a NAS folder.

### Accounts and services

All optional, and all set up in Settings.

| | Needed for |
|---|---|
| An OpenID Connect provider (Authentik, …) | Single sign-on; otherwise a password |
| A domain and a reverse proxy | HTTPS, and Claude.ai reaching the MCP server |
| Google Cloud project, or an ICS feed URL | Calendar matching; without one, meetings are still transcribed but get no titles or attendees |
| Hugging Face account | Speaker labels |
| Anthropic API key | Summarizing every meeting and finding its action items automatically; without it, ask Claude through MCP |
| Slack incoming webhook | The summary and action items in a channel |
| Zapier, Make or IFTTT | Sending tasks to Akiflow |
| Linear API key | Sending tasks to Linear |
| An S3 bucket | Archiving recordings to S3 |

## Getting started

### 1. Download Debrief

```sh
mkdir -p ~/debrief && cd ~/debrief
curl -fsSLO https://raw.githubusercontent.com/vitafortis/debrief/main/compose.yaml
curl -fsSL -o .env https://raw.githubusercontent.com/vitafortis/debrief/main/.env.example
```

### 2. Set the database password

The only setting `.env` needs:

```sh
sed -i "s/^DB_PASSWORD=.*/DB_PASSWORD=$(openssl rand -hex 16)/" .env
```

### 3. Start it

```sh
docker compose up -d
docker compose ps                 # five services, all running
docker compose logs -f web        # "Migrations applied.", then "Ready"
```

### 4. Set it up in the browser

Open `http://<server>:3000`. Debrief asks for your name, a password and your time zone, then takes you to **Settings**. Do this straight after starting it: until a password is set, anyone who can reach the page can choose it.

Everything from here on is in Settings:

The sections are listed down the side (on a phone, tap into one), each with a dot: green when it's working, amber when it needs you. Each page shows what most people change; the rest is under **Advanced**.

| Section | What's there |
|---|---|
| **Overview** | Every part at a glance, and the version: which build each service runs, whether one is down or behind, and whether a newer build is out. |
| **Account** | Your name, email, time zone and working hours; your password, and single sign-on through Authentik or another OpenID Connect provider. The address Debrief is reached at is under Advanced. |
| **Recorder & devices** | The recorder download, API keys for each recorder and MCP client, and each device's context, label and badge color. |
| **Calendars** | Your calendars, each with a context, and step-by-step adding: Google with one click, a Google service account, or an ICS link. |
| **Transcription** | Fast, balanced or most accurate, the language, and speaker labels. CPU or GPU and the rest are under Advanced. |
| **Storage** | Where recordings go once transcribed (the server, a NAS folder or S3), and watching a NAS folder. |
| **AI summaries** | The provider that writes summaries and finds action items: Anthropic, OpenAI, Google Gemini, or any OpenAI-compatible server (Ollama, LM Studio, OpenRouter). Plus the MCP address. |
| **Slack & tasks** | Slack, Akiflow and Linear, each with a Connect button. |

A setting can also go in `.env` under the same name (for example `ANTHROPIC_API_KEY=…`). That value wins, and Settings shows it with a lock.

### 5. HTTPS (recommended)

Put Debrief behind a reverse proxy before opening it to the internet. Port 3000 is the app, and 3001 is the MCP server, which Claude reaches at `/mcp`.

**With Traefik.** `compose.traefik.yaml` routes `https://<host>` to the app and `https://<host>/mcp` to the MCP server instead of publishing ports. It expects an external Docker network called `traefik` and an entrypoint called `websecure`. Download it and add two lines to `.env`:

```sh
curl -fsSLO https://raw.githubusercontent.com/vitafortis/debrief/main/compose.traefik.yaml
```

```sh
COMPOSE_FILE=compose.yaml:compose.traefik.yaml
DEBRIEF_HOST=debrief.example.com
```

Then `docker compose up -d` again, and set **Address** in Settings → Account → Advanced to `https://debrief.example.com`.

**Behind forward auth** (an Authentik outpost guarding the whole host): exempt `/api/recorder` and `/mcp`, which check their own API keys. To turn Debrief's own sign-in off, set `AUTH_MODE=none` in `.env`, and never publish port 3000 directly in that mode.

### 6. Sign in with Authentik (optional)

1. In Authentik, open **Applications → Providers → Create** and make an *OAuth2/OpenID Provider*:
   - **Client type:** Confidential
   - **Redirect URIs:** `https://debrief.example.com/api/auth/callback/oidc`
   - **Scopes:** the default `openid`, `email` and `profile` mappings
2. Create an **Application** that uses this provider, with the slug `debrief`, and grant access to your user or group.
3. In Settings → Sign-in, fill in the issuer (`https://auth.example.com/application/o/debrief/`), the client ID and secret, and optionally the emails allowed in.

The sign-in page then offers Authentik, with your password as a fallback.

### 7. Connect your calendars

In Settings → Calendars, choose **Add a calendar**. It walks you through three steps: where the calendar lives, connecting it (with **Check** to try it first), and naming it with a context, one short word like `work` or `side`.

**Google, sign in** (recommended). Once set up, connecting is one button and Debrief lists every calendar the account can see, to tick. Google needs an OAuth client from your own Google Cloud project first, a one-time job of about five minutes. The steps in Debrief show the exact address to paste:

1. [Create a Google Cloud project](https://console.cloud.google.com/projectcreate) and [enable the Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com) for it.
2. In [Google Auth Platform](https://console.cloud.google.com/auth/overview) → **Get started**, name the app Debrief. For **Audience**, choose **Internal** with a Google Workspace account. With a personal Gmail account, choose **External** and then **Publish app** on the Audience page: while an app is in testing, Google signs it out every 7 days. Google warns that your app isn't verified, which is expected.
3. Under [Clients](https://console.cloud.google.com/auth/clients) → **Create client** → **Web application**, add the redirect URI `https://debrief.example.com/api/google/callback` (your address). Google only accepts https:// here, except for localhost.
4. Paste the client ID and secret into Debrief, then **Connect Google**.

To add calendars from another Google account, choose **Google, sign in** again and **Connect another Google account**: Google asks which account to use, and each calendar keeps syncing through the account it was added with. An app with an **Internal** audience only lets in accounts from its own Workspace; for a Gmail account or another company's, the app has to be **External**.

**Google, service account.** For calendars you'd rather share one by one.

1. In the same Google Cloud project, create a service account under **IAM & Admin → Service accounts**, then **Keys → Add key → JSON**, and upload that file.
2. In Google Calendar, open each calendar's **Settings and sharing → Share with specific people** and add the service account's address (Debrief shows it, with a copy button) with **See all event details**.
3. Add the calendar by its ID (under **Integrate calendar**; for your main calendar it's your email address).

Or, with the Google Cloud CLI, run `gcloud auth application-default login --scopes=https://www.googleapis.com/auth/calendar.readonly,https://www.googleapis.com/auth/cloud-platform` and upload the file it saves; that works like signing in.

**Outlook, iCloud or other.** Any calendar with a private ICS link: Outlook's **Publish a calendar**, Google's **Secret address in iCal format**, or an iCloud public calendar. The steps for each are in Debrief. ICS links update less often; Outlook's can lag by a few hours.

### 8. Speaker labels (optional)

1. Create a free [Hugging Face](https://huggingface.co/join) account.
2. Accept the terms on [pyannote/speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1).
3. Create a **Read** token under Settings → Access Tokens and paste it into Debrief's Settings → Transcription.

Without it, transcripts work the same, but the other people on a call aren't told apart: a Debrief Recorder recording shows your lines and everyone else's as *Others*, and a recording from anywhere else has no speakers at all.

### 9. Summaries, Slack and tasks (optional)

- **Automatic summaries.** In Settings → AI summaries, pick a provider (Anthropic, OpenAI, Google Gemini, or your own OpenAI-compatible server such as Ollama) and add its key; **Test connection** checks it. Each new meeting is then summarized, and its action items found, as soon as it's transcribed and matched to its event.
- **Slack.** Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps) (*From scratch*), open **Incoming Webhooks**, turn them on, and **Add New Webhook to Workspace** for the channel you want. Paste the URL into Settings → Slack & tasks. For a channel per context, fill in *Slack webhook per context* (`work:https://hooks.slack.com/…,side:https://hooks.slack.com/…`).

  Once a meeting has its summary, Slack gets the title, time, length and attendees, the summary, and every action item with its details, owner, due date, priority, destination and a link to the moment it was said. Each meeting is posted once; **Slack → Send again** on a recording's page posts it again.
- **Akiflow** has no public API, so Debrief posts each task to a webhook and an automation creates it.
  1. In Zapier (or Make, or IFTTT), create a Zap with a **Webhooks by Zapier → Catch Hook** trigger and an **Akiflow → Create Task** action.
  2. Map `title`, `description`, `date`, `due_date`, `duration` and `priority` from the hook.
  3. Paste the hook URL into Settings → Slack & tasks.

  Each task arrives as:

  ```json
  {
    "title": "Follow up with Sarah on API timeline",
    "date": "2026-10-23",
    "duration": 30,
    "priority": "high",
    "due_date": "2026-10-25",
    "description": "From Standup 10/22 — Sarah mentioned API v2 timeline may slip\nhttps://debrief.example.com/recordings/…?t=125",
    "context": "work",
    "uniqueIdentifier": "debrief-<meeting id>-1"
  }
  ```
- **Linear.** Create a personal API key under Linear's Settings → Security & access, and paste it into Settings → Slack & tasks with a team key (e.g. `ENG`), or a team per context (`work:ENG,side:SIDE`).

Each calendar has a default destination (Settings → Calendars → *Tasks go to*), and you can change it on any task.

### 10. Set up recording on each desktop

1. In Debrief, open **Settings → Recorder & devices** and create a key for this computer (e.g. *Work MacBook*). Copy it; it's shown once.
2. Download the recorder from the same page (**Mac** or **Windows**), or from the [latest release](https://github.com/vitafortis/debrief/releases/latest).
   - **Mac:** open the `.dmg` and drag **Debrief Recorder** to Applications. Unless it was built with a Developer ID (see [Signing the Mac recorder](#signing-the-mac-recorder)), macOS blocks it the first time: open System Settings → Privacy & Security and click **Open Anyway**. (If macOS still refuses: `xattr -dr com.apple.quarantine "/Applications/Debrief Recorder.app"`.)
   - **Windows:** run the installer. SmartScreen warns about an unsigned app: **More info → Run anyway**.
3. It opens its Settings window the first time (later: the waveform icon in the menu bar or tray → **Settings…**):
   - **Server:** `https://debrief.example.com`, or `http://<server>:3000` on your LAN. Optionally a **fallback server** for when the first can't be reached, such as the LAN address at home.
   - **API key:** the one from step 1.
   - **This computer's name:** how it shows up in Debrief (defaults to the computer's name).
   - **Test connection**, then **Save**.
4. Allow the permissions it asks for the first time it records:
   - **Mac:** *Microphone*, and *Screen & System Audio Recording* (System Settings → Privacy & Security → Screen & System Audio Recording → Debrief Recorder). Without it, only your side of the call is recorded (the recorder warns you if that happens) and shared screens aren't kept.
   - **Windows:** microphone access for desktop apps (Settings → Privacy & security → Microphone).
5. **Record a test call.** Join any call, answer **Record** in the popup, and hang up. A minute or two later it's on the dashboard: *Queued*, then *Transcribing*, then *Ready*. The first one takes a few minutes longer while the Whisper model (about 3 GB) downloads.

### Archive to a NAS

`compose.nas.yaml` mounts a NAS share into the containers. Use it to archive recordings to the NAS, to pick up recordings from Meetily or Syncthing, and to keep a copy of every transcript and meeting notes file there.

1. **Share a folder from the NAS.** On Unraid, for example: create a share called `meetings`, turn on **NFS export** (Shares → meetings → NFS Security Settings → Export: Yes), and limit it to the server's IP with a rule such as `192.168.1.20(rw,sec=sys,no_root_squash)`. Inside it, create `audio/` and `exports/`. Unraid shares belong to `nobody:users` (uid 99, gid 100).
2. **Mount it on the server:**

   ```sh
   sudo mkdir -p /mnt/meetings
   echo 'nas.lan:/mnt/user/meetings  /mnt/meetings  nfs  rw,hard,noatime,vers=4.2,_netdev  0 0' | sudo tee -a /etc/fstab
   sudo mount /mnt/meetings
   ls /mnt/meetings        # audio  exports
   ```
3. **Add the overlay.** Download `compose.nas.yaml` and add it to `COMPOSE_FILE` in `.env` (with `compose.traefik.yaml` too, if you use it), with the share's owner:

   ```sh
   curl -fsSLO https://raw.githubusercontent.com/vitafortis/debrief/main/compose.nas.yaml
   ```

   ```sh
   COMPOSE_FILE=compose.yaml:compose.nas.yaml
   MEETINGS_UID=99
   MEETINGS_GID=100
   # AUDIO_PATH / EXPORTS_PATH if the share isn't at /mnt/meetings/audio and /mnt/meetings/exports
   ```
4. `docker compose up -d`, then in Settings → Storage choose *In a NAS folder*, save, and press **Test archive**.

Archived recordings land in `audio/<device>/<start>_<id>/audio.opus`, beside a `metadata.json` that says when and what it was, so the archive makes sense on its own.

**To S3 instead.** Choose *In S3 storage* in Settings → Storage and fill in the bucket, keys, region and, for anything but AWS, the endpoint (`https://<account>.r2.cloudflarestorage.com`, `https://s3.us-west-004.backblazeb2.com`, `http://minio.lan:9000`). Meetings stored there play straight from the bucket through short-lived links.

### Recordings from Meetily or other apps

**With Meetily and Syncthing.** This needs the NAS overlay and **Watch the NAS folder for new audio** on (Settings → Storage → Advanced).

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

- A timestamp in the file name (`2026-10-22 14.03 Standup.m4a` or `20261022_140300.wav`) is read as the start time, in your time zone (Settings → Account).
- Otherwise the start time is worked out from the file's modified time and length. That works as long as your sync tool keeps modified times (Syncthing and `rsync -a` do).

## Using Debrief

### Day to day

1. **Take the call.** The recorder asks (or just starts, by your rules) when the meeting app takes the microphone, and stops when the app lets go. Nothing joins the call.
2. **Read the summary in Slack**, or open the home page. From the top:
   - **Finish setting up**, while something is missing: the recorder, a calendar, an AI provider, and the optional speaker labels and Slack, Akiflow or Linear, each with what it unlocks. It goes once the required ones are done.
   - **Transcriptions**: what's queued or transcribing, and what's ready that you haven't opened yet.
   - **The calendar**, by day or week. It opens on your working hours (Settings → Account) and scrolls for the rest; a marker shows how many meetings are earlier or later. Beside it, the month marks recorded days, upcoming meetings and days with something to clean up: tap a day to go there. **Coming up** lists your next meetings, with a link to join.
   - **Needs cleanup**: every recent transcript that's untitled, has no calendar event, unnamed speakers, no summary or tasks yet, tasks to review, or is empty, with a button for the fix.
3. **Get the action items.** With an AI provider set up (Settings → AI summaries) they're already there. Otherwise ask Claude *"Extract the action items from today's standup in Debrief"* (see [Connecting Claude](#connecting-claude)).
4. **Review and send them** on the Tasks page (below).

### The sidebar and calendar filter

Under **Calendars** in the sidebar, pick a context (e.g. *Acme*) to narrow every page to it: the home page, recordings, calendar, search and tasks. **All** shows everything. The choice is remembered. Press **⌘B** (Ctrl+B) to collapse the sidebar; the sun and moon button switches between light and dark.

At the bottom of the sidebar is the version you're running, with a dot: green when every service is up and on the same build, blue when a newer build is out, amber when a service is down or on a different build. Click it to see each service and what to do. Updating is pulling the images and redeploying the stack.

### Recordings

**Recordings** in the sidebar lists everything recorded, newest first:
- **Status counts** along the top: recording or uploading, queued, transcribing, failed, and to review. The sidebar also shows a count while anything is queued or transcribing.
- **In progress:** anything still uploading, queued, transcribing or failed is listed above the rest, with **Retry** for a failure.
- **Filters:** **To review** shows what's transcribed but not opened yet (each is marked *To review* in the list), **Reviewed** what you've opened, and **No event** what didn't match a calendar event. Search by words, attendee, device and date.
- **Deleting:** tick several and **Delete** removes them everywhere at once.

### A recording

Open one from the dashboard, **Recordings** or the **Calendar**.

**Playing and reading:**
- **Player:** play/pause with the button or the space bar. **J** and **L** skip 10 seconds, the arrow buttons skip 15, and you can change the speed or click the waveform to jump.
- **Transcript:** click any line to play from there. **Follow** keeps the line being spoken in view; scrolling turns it off.
- **Find in transcript:** marks every match. Press Enter (or Shift+Enter) to step through them.

**Fixing the details:**
- **Title:** click it to rename the recording. Leave it empty to use the calendar event's title.
- **Calendar event:** if the time matching picked the wrong event, or nothing, choose the right one from the events around that time. *Match automatically* goes back to matching by time.
- **Speakers:** with speaker labels on, the transcript says *Speaker 1*, *Speaker 2* and so on. Type names under **Speakers** and they're used everywhere: the transcript, search, exports and what Claude reads. With one other person on the calendar event, the call's side is named after them without typing: *Others* (or the one speaker on the call's side) becomes their name, or their email if the calendar has no name. That needs to know which attendee is you: your email in Settings → Profile, or the Google account the calendar comes from.
- **Summary:** Claude writes one when it extracts tasks. Click it to edit, or write your own.

**Shared screens:** when someone presented during a recorded call, the **Shared screens** tab beside the transcript shows each slide or document with its time (click it to play from there) and the text read from it. That text also goes into the summary, the exports and search by Claude.

**Window video:** when the recorder kept a video of the call's window (macOS 15 and later), it plays above the waveform in step with the audio, so you can watch someone type, scroll or point at things. **Video** beside *Follow* hides it.

**Action items:** shown for this meeting. Add one by hand with **Add**.

**Export:** **Markdown** downloads the summary, action items and transcript with speakers and times. **Text** is the bare transcript. With a NAS mounted, the same Markdown is saved there (`exports/<day>/<title>-<id>.notes.md`) whenever the summary changes. **Slack** posts the summary and action items (again).

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

See [step 4](#4-set-it-up-in-the-browser) for what each section holds. A few details:

- **Calendars:** switching one off hides its events; **Edit** renames its context (everywhere) and sets where its tasks go; **Sync now** syncs straight away (it also syncs every 5 minutes).
- **Recorder & devices:** every computer recordings have come from (the recorder's name, or the Syncthing folder). Nothing is tagged by device until you pick a context for one. Give each a short label and a color: it shows as a badge wherever its recordings appear, and a recording with no calendar event or name shows as *Untitled* with that badge rather than a long date. A device's context is only used for meetings without a calendar event; the event's calendar always wins. API keys are shown once; Debrief keeps only a hash, and revoking one signs that recorder or Claude client out at once.
- **Secrets** (API keys, tokens, webhooks) are never shown again once saved. Type a new one to replace it, or **Remove** it.

## The recorder

| | |
|---|---|
| <img src="docs/screenshots/recorder.png" width="380" alt="The recorder's settings"> | <img src="docs/screenshots/recorder-prompt.png" width="380" alt="Record this meeting?"><br><br>**The popup** when an app with an *Ask* rule takes the microphone.<br><br>**Settings:** the live recording with levels for both sides, what's uploaded, the server and key, the rules per app, and audio and storage options. |

**The menu.** Click the waveform icon in the menu bar (Mac) or tray (Windows). It shows whether it's recording and for how long, and whether everything is uploaded. From the menu you can start or stop a recording by hand, open Debrief, show the recordings folder, open Settings, check for updates, or quit. While recording, the icon turns red.

**When an app takes the microphone,** the recorder follows that app's rule:

| Rule | What happens |
|---|---|
| **Ask** | A small popup in the top right: *Start recording? Zoom is using your microphone.* Choose **Record** (optionally naming it first), ✕ for not now, or **Always record** or **Never ask** for Zoom. It doesn't take the keyboard, so typing in the call (or a shortcut in another app) never answers it. Unanswered, it goes away after a minute, as *Not now*. |
| **Always record** | Recording starts straight away. |
| **Never** | Nothing happens. |

- Rules match the app's name or bundle id, ignoring case: `zoom` matches `zoom.us`. The defaults are *Ask* for Zoom, Teams, Webex, Slack and FaceTime, and *Never* for Discord. Apps without a rule get the default (*Ask*), except screen recorders and dictation apps, which are left alone: Loom, OBS, QuickTime Player, Screen Studio, CleanShot X, Kap, Camtasia, Snagit, ScreenFlow, Voice Memos, Audio Hijack, Superwhisper, Wispr Flow, MacWhisper and the Snipping Tool. Add a rule for one of them to be asked after all.
- **Any other app** has its own setting. Set it to *Record* to record everything except your *Never* list.
- Browser calls (Google Meet) show up as the browser, e.g. *Google Chrome*.
- Settings lists the apps using the microphone right now; click one to add a rule for it.
- A recording started for an app stops when that app has let go of the microphone for 45 seconds (adjustable). One started by hand runs until you stop it.
- *Not now* holds until that app lets go of the microphone; the next call asks again. Stopping a recording yourself does the same, even for an app set to *Always record*: it won't start again until the next call.

**What's recorded.** Your microphone on the left channel and the call on the right, as Opus at 48 kbit/s: about 21 MB an hour. Pick a microphone in Settings, or turn off the computer's audio.

- **Just the meeting app** (on by default): when an app started the recording, only that app's sound is recorded, not notifications, music or videos elsewhere. A browser is recorded whole, every tab, since browsers play all their tabs through one process. Recordings started by hand record everything the computer plays. This needs macOS 14.2 or Windows 10 version 2004 or later; if the app's sound can't be captured, it records everything instead.
- **If the microphone drops out** (a Bluetooth headset switching into call mode, a USB microphone unplugged), it's opened again within a few seconds, following the system default unless you chose a microphone. If it recorded only silence, the recorder says so when it stops.

**Shared screens** (on by default). While an app's call is recorded, the recorder looks at that app's window every 3 seconds and keeps a frame when it has held still and changed from the last one kept: a slide or a document someone is presenting, not a grid of moving faces. Browsers are only looked at while the window's tab is the call (*Meet*, *Teams*, *Zoom* and so on in its title). After transcribing, Debrief reads the text on each frame with Tesseract and keeps the ones with a dozen words or more that aren't a repeat of the one before; the rest are deleted. The window has to be open (behind other windows is fine, minimized isn't). What you share yourself isn't kept. Frames stay on the server's recordings volume beside the audio and aren't archived to the NAS or S3; deleting the recording deletes them.

**Screen video** (on by default, Mac only for now; needs *Shared screens* on and macOS 15 or later). The same window is also recorded as an MP4 at 5 frames a second, up to 1920 pixels wide, with the pointer, so movement is kept and not just the still frames. A new file starts whenever the window changes, and recording pauses while the window is minimized or, in a browser, while another tab is showing. The videos go up after the audio, in resumable 8 MB pieces, so the transcript isn't kept waiting. They sit on the server's recordings volume as `video/<ms>.mp4` beside the audio, aren't archived, and are deleted with the recording. On Windows only the still frames are kept.

**Uploading.** Audio goes up about every 20 seconds while recording, so Debrief has nearly all of it when you hang up. The recording is always written to disk first. With no connection (a plane, a hotel, the server down), it keeps recording and uploads later, retrying with backoff; Settings and the menu show what's waiting and why. Uploads resume exactly where they stopped. A recording the app was quit or crashed in the middle of is uploaded as far as it got; one that never finishes uploading (the laptop died) is transcribed anyway after 12 hours (Settings → Storage).

**Copies on the computer.** Recordings stay in the recordings folder (Settings → *On this computer*) for 14 days after they're uploaded, then they're deleted; 0 deletes them as soon as Debrief has them. The server (and its archive) keeps the original.

**Updates.** The recorder looks for a newer release on GitHub a minute after it starts and then once a day. When there is one, the menu shows *Update to 0.1.40…* and Settings shows **Install and restart**: it downloads the update, checks its signature, puts it in place of the old version and restarts, with no installer and, on a Mac, no Gatekeeper prompt. It won't while recording, since restarting would end the recording. If the update can't be installed that way, or the recorder was built without the [updater's key](#updates-to-the-recorder), the download opens instead; install it over the old one. Settings shows the version, with **Check for updates**, and Debrief's Settings → Recorder & devices shows the version each key was last used by. Recorders from before self-updating have to be updated by hand once more, and those from before 0.1.12 don't check at all: download the newest from Settings → Recorder & devices and install it over the old one.

**Settings** are stored in `~/Library/Application Support/io.github.vitafortis.debrief.recorder/settings.json` (Mac) or `%APPDATA%\io.github.vitafortis.debrief.recorder\settings.json` (Windows), readable only by you, API key included. Logs are in `~/Library/Logs/io.github.vitafortis.debrief.recorder/` or `%LOCALAPPDATA%\io.github.vitafortis.debrief.recorder\logs\`.

## Connecting Claude

The MCP server is at `https://debrief.example.com/mcp` behind a reverse proxy, or `http://<server>:3001/mcp` on your LAN. It authenticates every request with a bearer token: an API key from **Settings → Recorder & devices** (make one per client), or the fixed token in Settings → AI summaries → Advanced if you set one.

**Claude Code:**

```sh
claude mcp add --transport http debrief https://debrief.example.com/mcp \
  --header "Authorization: Bearer <API key>"
```

**Claude Desktop.** Add this to `claude_desktop_config.json` (Settings → Developer → Edit Config) and restart Claude:

```json
{
  "mcpServers": {
    "debrief": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://debrief.example.com/mcp", "--header", "Authorization: Bearer <API key>"]
    }
  }
}
```

**Things to ask:**
- *"What did I agree to do in meetings this week?"*
- *"Extract the action items from the Northwind onboarding call and save them."*
- *"Search my meetings for anything about the API v2 timeline."*
- *"Send the approved lumen tasks to Linear."*

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

Settings live in the database too, so this backs them up. Recordings are in the `recordings` volume until they're archived; back up the NAS share or bucket as usual. The `models` volume can always be downloaded again.

**From an older Debrief (Postgres 16, NAS-only).** Debrief now runs Postgres 18, which can't open a Postgres 16 data folder. Before pulling:

1. Back up the database as above, with the old stack still running.
2. Replace `compose.yaml` and `.env` with the new ones (keep `DB_PASSWORD`), and add `compose.nas.yaml` so existing recordings stay playable from the NAS. Settings from your old `.env` keep working there; move them into Settings when convenient.
3. `docker compose down`, `docker volume rm debrief_pgdata`, `docker compose up -d postgres`, restore the dump, then `docker compose up -d`.

## Troubleshooting

| What you see | What to check |
|---|---|
| A recording never shows up | Settings → Overview shows the queue and whether the transcriber is running. `docker compose logs web` shows the upload, and `docker compose logs transcriber` the transcription. A Meetily recording needs the NAS overlay and watching on, and is picked up once its `metadata.json` says `completed` (other files once they've stopped growing for a minute). |
| Stuck on *Queued* | One recording is transcribed at a time, newest first. Check the transcriber log for progress, and the dashboard queue for errors. |
| *Failed* with "Permission denied" | With the NAS overlay, set `MEETINGS_UID`/`MEETINGS_GID` to the share's owner (`99`/`100` on Unraid). |
| "The recording isn't on the server or in the archive any more" | The server's copy was removed after archiving, and the archive can't be reached: check the NAS is mounted, or the S3 settings (**Test the archive**). |
| Archiving fails | `docker compose logs calendar-sync` says why; **Test archive** in Settings → Storage checks the settings. |
| The recorder says "Can't reach Debrief" | **Test connection** in its Settings says why. From outside, `https://<host>/api/recorder/ping` must reach the `web` container, not a sign-in page (exempt `/api/recorder` from forward auth). |
| The recorder says the API key is unknown | It was revoked, or mistyped. Make a new one in Settings → Recorder & devices. |
| Only my side of the call was recorded | Mac: allow Debrief Recorder under Privacy & Security → Screen & System Audio Recording, and check *Record the computer's audio too* is on. If the call was in an app the recorder doesn't capture well, turn off *Just the meeting app*. |
| My side of the call is silent | The microphone was cut off or muted. The recorder now reopens a microphone that stops; check the one chosen in its Settings, and on a Mac that it's allowed under Privacy & Security → Microphone. |
| No shared screens | The recorder's *Shared screens* must be on, and on a Mac it needs Screen & System Audio Recording. The call's window must be open, and for a browser the call must be the window's current tab. Frames with little text are dropped on purpose. The transcriber log says "Shared screens of …: kept N of M". |
| The popup never appears | The recorder's Settings → *When an app uses the microphone* must be on, and the app's rule must be *Ask*. Settings lists the apps it sees using the microphone; if yours isn't there while in a call, check the app has microphone access. |
| No Slack message | Settings → Overview shows whether Slack is set up. `docker compose logs calendar-sync` shows "sent to Slack" or Slack's error. Messages go out once a meeting has a summary. |
| A meeting has no calendar event | Is the calendar synced (Settings → Calendars shows the last sync or an error)? Is the time zone right? A recording needs to overlap an event by 70%. Pick the event by hand on the recording's page if needed. |
| Calendar error "Not Found" or 403 | The service account hasn't been given access to that calendar, or the calendar ID is wrong. Debrief's message on the calendar says which. |
| Google says "redirect_uri_mismatch" | The redirect URI in Google Cloud must match the one shown in Debrief's steps exactly, https:// included. Behind a proxy, set the address in Settings → Account → Advanced. |
| Google stops syncing after a week | The OAuth app is still in testing. In Google Auth Platform → Audience, choose **Publish app**, then connect Google again. |
| A service shows amber in Overview | It's down, or running a different build from the web app. Pull the images and redeploy the whole stack so they match. |
| No speaker names, only lines | The Hugging Face token isn't set, or the pyannote model's terms weren't accepted (the transcriber log says "Speaker labels are off: …"). Then press **Transcribe again**. |
| **Send** is greyed out | That destination isn't set up in Settings → Slack & tasks. |
| Sign-in loops or says "didn't finish" | Authentik's redirect URI must be exactly `https://<host>/api/auth/callback/oidc`, and your proxy must pass the original host. Sign in with the password meanwhile. |
| Locked out | Set `DEBRIEF_PASSWORD=…` in `.env` and `docker compose up -d`: that password then works, whatever is in Settings. |
| Claude gets 401 | The `Authorization: Bearer` header must be an API key from Settings (or the fixed MCP token). |

## Configuration reference

Settings are made in the app. Each one can also be set in `.env` under the name below, which then wins (the compose file passes `.env` to every service).

| Setting | Name | Default |
|---|---|---|
| Your name, email | `OWNER_NAME`, `OWNER_EMAIL` | |
| Time zone | `TZ` | `UTC` |
| Working hours, for the home calendar | `WORK_DAY_START`, `WORK_DAY_END` | `8`, `18` |
| Address | `PUBLIC_URL` | |
| Single sign-on | `AUTH_OIDC_ISSUER`, `AUTH_OIDC_ID`, `AUTH_OIDC_SECRET`, `AUTH_OIDC_NAME`, `ALLOWED_EMAILS` | |
| Google credentials | `GOOGLE_CREDENTIALS` (the JSON), or `GOOGLE_CREDENTIALS_FILE` (a path) | |
| Calendar sync | `POLL_INTERVAL_SECONDS`, `SYNC_DAYS_BACK`, `SYNC_DAYS_AHEAD`, `MATCH_THRESHOLD` | `300`, `30`, `14`, `0.7` |
| Archive | `ARCHIVE` (`off`, `folder`, `s3`), `KEEP_LOCAL_DAYS` | `off`, `7` |
| S3 | `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_PREFIX`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | AWS, `us-east-1`, `debrief/` |
| Watching | `WATCH_FOLDER`, `SCAN_INTERVAL`, `STABLE_SECONDS` | `false`, `30`, `60` |
| Unfinished uploads | `ABANDON_HOURS` | `12` |
| Transcription | `WHISPER_MODEL`, `WHISPER_DEVICE`, `COMPUTE_TYPE`, `CPU_THREADS`, `LANGUAGE`, `BEAM_SIZE` | `large-v3`, `cpu`, `int8` on CPU, all cores, detected, `5` |
| Speaker labels | `HF_TOKEN`, `DIARIZE` | on when there's a token |
| AI provider | `AI_PROVIDER` (`anthropic`, `openai`, `gemini`, `custom`), `AUTO_EXTRACT` | `anthropic`, `true` |
| Anthropic | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | `claude-haiku-5-5` |
| OpenAI | `OPENAI_API_KEY`, `OPENAI_MODEL` | `gpt-5-mini` |
| Google Gemini | `GEMINI_API_KEY`, `GEMINI_MODEL` | `gemini-2.5-flash` |
| Your own server | `AI_BASE_URL` (OpenAI-compatible, e.g. `http://ollama:11434/v1`), `AI_API_KEY`, `AI_MODEL` | |
| MCP | `MCP_TOKEN` | |
| Google sign-in | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | |
| Update check | `UPDATE_CHECK` | `true` |
| Slack | `SLACK_WEBHOOK_URL`, `SLACK_WEBHOOKS` | |
| Tasks | `AKIFLOW_WEBHOOK_URL`, `AKIFLOW_DEFAULT_DURATION`, `LINEAR_API_KEY`, `LINEAR_TEAM`, `LINEAR_TEAMS` | `30` minutes |

Only in `.env`:

| Name | |
|---|---|
| `DB_PASSWORD` | Required |
| `COMPOSE_FILE` | The overlays: `compose.yaml:compose.traefik.yaml:compose.nas.yaml` |
| `WEB_PORT`, `MCP_PORT` | `3000`, `3001` |
| `DEBRIEF_HOST` | The host Traefik serves Debrief on (`compose.traefik.yaml`) |
| `AUDIO_PATH`, `EXPORTS_PATH`, `MEETINGS_UID`, `MEETINGS_GID` | The NAS share (`compose.nas.yaml`) |
| `DEBRIEF_TAG` | An image tag to stay on |
| `DEBRIEF_PASSWORD` | A password that always works, overriding the one set in the app |
| `AUTH_MODE=none` | No sign-in, for when a proxy in front already guards Debrief |
| `GOOGLE_CALENDARS`, `ICS_CALENDARS` | Calendars to add at startup: `work:you@company.com,side:primary` |

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
3. Choose **GPU (CUDA)** under Settings → Transcription → Device.
4. Run a CUDA build of the transcriber image, built from an `nvidia/cuda:12-cudnn9-runtime` base instead of `python:3.12-slim`. That build isn't published yet.

## Development

You need Node 24, pnpm 9, Python 3.12 with [uv](https://docs.astral.sh/uv/), and Docker for Postgres.

```sh
docker run -d --name debrief-db -e POSTGRES_USER=debrief -e POSTGRES_PASSWORD=debrief -e POSTGRES_DB=debrief -p 127.0.0.1:55520:5432 postgres:18-alpine
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

### Signing the Mac recorder

Without a certificate, the Mac recorder is signed ad hoc: macOS treats every new version as a different app, so Microphone and Screen Recording have to be allowed again after each update. Signing every build with the same certificate fixes that, and a self-signed one is enough. Notarizing as well, which needs a Developer ID (the Apple Developer Program, $99 a year), also stops Gatekeeper blocking the app the first time it's opened.

**Self-signed**

1. On a Mac, in Keychain Access → Certificate Assistant → Create a Certificate: name it (say `Debrief Recorder Signing`), Identity Type **Self Signed Root**, Certificate Type **Code Signing**, and tick **Let me override defaults** to set the validity to 3650 days, since a new certificate means allowing the permissions again.
2. In Keychain Access → login → My Certificates, right-click it → **Export**, as a `.p12` with a password. Then `base64 -i Certificates.p12 | pbcopy`.
3. In the GitHub repository → Settings → Secrets and variables → Actions, add `APPLE_CERTIFICATE` (the base64), `APPLE_CERTIFICATE_PASSWORD` (the `.p12`'s password) and `APPLE_SIGNING_IDENTITY` (the certificate's name exactly).

macOS still blocks each newly downloaded version the first time: System Settings → Privacy & Security → Open Anyway.

**Developer ID, notarized**

1. Join the [Apple Developer Program](https://developer.apple.com/programs/enroll/) as an individual (or an organization, if its name should be the one macOS shows).
2. On a Mac, in [Certificates](https://developer.apple.com/account/resources/certificates/list), create a **Developer ID Application** certificate (Keychain Access → Certificate Assistant → Request a Certificate From a Certificate Authority, saved to disk, makes the request it asks for). Download it and double-click it to add it to the login keychain.
3. Export it as in step 2 above.
4. At [account.apple.com](https://account.apple.com) → Sign-In and Security → App-Specific Passwords, make one for notarizing.
5. Add these secrets:

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | the base64 from step 3 |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12`'s password |
| `APPLE_SIGNING_IDENTITY` | the certificate's name exactly, `Developer ID Application: Your Name (ABCDE12345)` |
| `APPLE_ID` | your Apple Account's email |
| `APPLE_PASSWORD` | the app-specific password from step 4 |
| `APPLE_TEAM_ID` | the 10 characters in brackets (also under Membership details) |

Either way, the next build of the recorder is signed with the certificate, and checked that it is; a notarized one is also checked with Gatekeeper's own `spctl`, and its release notes say so. Install that version once and allow Microphone and Screen Recording one last time; later versions keep them. Delete the `.p12` once the secret is saved.

### Updates to the recorder

The recorder installs its own updates once the release workflow signs them. The key for that is Tauri's own, not Apple's, and costs nothing:

1. With Node installed, run `npx @tauri-apps/cli@2 signer generate -w ~/.tauri/debrief-recorder.key` and choose a password. It writes the private key to that file and the public key to `~/.tauri/debrief-recorder.key.pub`.
2. Add the secrets `TAURI_SIGNING_PRIVATE_KEY` (the contents of `~/.tauri/debrief-recorder.key`) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (the password).
3. Put the contents of `~/.tauri/debrief-recorder.key.pub` in `recorder/src-tauri/tauri.conf.json` as `plugins.updater.pubkey`, and commit it.

From then on, each release has a signed update for each platform and a `latest.json` listing them, and the build fails if the update doesn't verify against that public key. Keep the private key somewhere safe: releases signed with a different key won't install over versions that have the old public key, and have to be installed by hand.

## License

[Apache-2.0](LICENSE)
