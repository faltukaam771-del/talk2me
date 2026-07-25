# talk2you

A private, WhatsApp-style, text-only chat web app for exactly two people — `admin` and `user` — built with Flask + Socket.IO, backed by Google Sheets for storage, and deployed on Render.

---

## Tech stack

| Layer | Choice |
|---|---|
| Backend | Flask 3, Flask-SocketIO (gevent worker) |
| Real-time | Socket.IO (WebSocket, falls back to polling) |
| Storage | Google Sheets (via `gspread` + a service account) |
| Frontend | Vanilla HTML/CSS/JS (no framework, no build step) |
| Hosting | Render (gunicorn + `GeventWebSocketWorker`) |

No database server, no build pipeline — the whole app is a handful of files.

---

## Features

### Messaging
- **Real-time send/receive** over Socket.IO — messages appear instantly for both people without a page refresh.
- **Persistent history** — every message is saved to a Google Sheet, so restarts/redeploys never lose the conversation. Only the most recent 500 messages are loaded per page view, so history stays fast to load no matter how long the chat gets.
- **Manual refresh button** (⟳, left side of the input box) — reloads the chat from the server on demand, for when a message doesn't arrive live. Keeps the mobile keyboard open when tapped (doesn't steal focus from the input).
- **Admin-only delete** — admin can delete any message; it plays a small particle-burst dissolve animation for everyone, and only admin sees a "Message deleted" confirmation popup.

### Message status (ticks)
- Single grey tick = sent.
- Double grey tick = delivered (the other person's browser received it).
- Double blue tick = read (the other person's chat window was in focus when it arrived, or they scrolled back and it came into view).

### Time & timezone
- All timestamps are stored in UTC internally but always displayed in IST (India Standard Time), both for chat history and for live messages, regardless of what timezone the Render server itself is running in.

### Presence & typing
- **Online/offline status** for the other person, shown in the header ("Active now" / "Offline").
- **Device count** — both admin and user can see how many active devices/tabs each of them currently has open (e.g. "You 2 · user 1"), tracked per Socket.IO connection.
- **Typing indicator** — small animated dots appear near the input area when the other person is typing, and disappear a moment after they stop.

### Admin session controls
Admin has a session-management button in the header with two options:
1. **Log out `user` — all devices.** Every tab/device the user is logged into gets force-redirected to the login page immediately (only shown when the user actually has an active device).
2. **Log out admin — other sessions only.** Force-logs-out every *other* admin session (other devices/tabs), while leaving the current one logged in — useful if admin forgot to log out on another device/browser.

Both use a real Socket.IO event targeted at the specific browser tab(s), not a blunt broadcast — so only the intended session(s) get logged out.

### Look & feel
- **WhatsApp-style bubble UI** — own messages right-aligned (green), other person's left-aligned (white/dark), with sender name shown above their bubbles.
- **Dark mode**, on by default, toggleable via a sun/moon icon in the header; choice is remembered (`localStorage`) across visits.
- **Textured chat background** — subtle dot-grid + soft color glows, theme-aware (different accent tones for light vs dark), so the background isn't a flat block of color.
- **Custom popups everywhere** — no native browser `alert()`/`confirm()` dialogs anywhere. Errors, delete confirmations, and the admin session-choice menu all use custom-styled, theme-aware cards/toasts instead.
- **Particle-burst delete animation** — deleting a message shrinks the bubble in place while small particles scatter outward from it, then the row collapses smoothly.
- **Polished custom SVG icons** — chat-bubble logo (favicon + header avatar) with gradient shading and a soft drop shadow instead of a flat icon.

### Mobile-specific fixes
Mobile chat UIs commonly break around the on-screen keyboard; this app specifically handles:
- **Header stays fixed at the top** of the screen at all times, keyboard open or not.
- **Input bar (+ typing indicator) is grouped and tracks the keyboard height in real time**, so it always sits directly above the keyboard instead of being hidden behind it or leaving a gap.
- **Tapping refresh doesn't close the keyboard** — the button is prevented from stealing focus from the message input.
- **Sending a message doesn't close the keyboard** — focus is programmatically kept on the input box after send, so the next message can be typed immediately without tapping the input again.

### Reliability fixes under the hood
These aren't user-facing features, but they're what keep the app from silently breaking after it's been running a while:
- **`gevent.monkey.patch_all()` runs as the very first line of `app.py`** — before any other import. Without this, the gunicorn `GeventWebSocketWorker` patches the SSL/socket stack too late, which under load caused an infinite-recursion crash (`RecursionError: maximum recursion depth exceeded`) whenever Google's auth library tried to refresh its access token — which happens roughly every hour, so the app would work fine for a while and then silently stop sending messages.
- **`max_decode_packets=200`** is set on the Socket.IO server (default is 16) — the low default caused `ValueError: Too many packets in payload` whenever a reconnecting client tried to flush a backlog of buffered events (typing/read-receipts) all at once.
- **Cached Google Sheets worksheet handles** — looking up a worksheet by name costs multiple API calls; doing that on every single message would blow through Google's free-tier rate limit. The handle is resolved once at startup and reused, with automatic retry + full-reconnect-and-retry if a call ever fails (e.g. after a long idle period).
- **Bounded history reads** — the sheet is never read in full; only the most recent 500 rows are pulled, so a page load stays fast even after months of chatting.
- **Last-known-good message cache** — if a live Google Sheets read fails (rate limit, transient network issue), the app serves the last successfully loaded copy of the history instead of showing a broken or empty chat.
- **Friendly error page** — any unhandled server error shows a simple "Something went wrong, try again" page instead of a raw stack trace.

---

## Project structure

```
talk2you/
├── app.py                     # Flask app, routes, all Socket.IO event handlers
├── requirements.txt
├── Procfile                   # gunicorn + GeventWebSocketWorker start command
├── runtime.txt                # pins the Python version
├── utils/
│   └── sheets_handler.py      # all Google Sheets read/write/cache/retry logic
├── templates/
│   ├── join.html               # login page (admin / user + shared password)
│   ├── chat.html                # the chat UI itself
│   └── error.html               # friendly fallback error page
└── static/
    ├── css/style.css           # all styling (light + dark themes)
    ├── js/chat.js               # all client-side behavior
    └── icons/chat-logo.svg      # app icon / favicon
```

---

## How login works

There's no signup and no per-user accounts table — just two fixed roles, `admin` and `user`, each with its own password set via environment variables. Whoever logs in as `admin` gets the delete button, session-management controls, and sees "Message deleted" confirmations; whoever logs in as `user` is the other side of the conversation. Multiple devices can be logged into the same role at once (that's what the device-count feature is showing).

---

## Environment variables required

| Variable | Purpose |
|---|---|
| `ADMIN_PASSWORD` | Password for the `admin` role |
| `USER_PASSWORD` | Password for the `user` role |
| `SECRET_KEY` | Flask session signing key |
| `ROOM_NAME` | Display name shown in the header (optional, defaults to "Our Chat") |
| `GOOGLE_SHEET_ID` | The ID from your Google Sheet's URL |
| `GOOGLE_CREDENTIALS_JSON` | The full service-account JSON key, as a single-line string |

### One-time Google Sheets setup
1. Google Cloud Console → new project.
2. Enable the **Google Sheets API** and **Google Drive API**.
3. IAM & Admin → Service Accounts → create one → Keys → Add Key → JSON. Save that file's contents as `GOOGLE_CREDENTIALS_JSON`.
4. Create a Google Sheet, copy its ID out of the URL (`.../d/<THIS PART>/edit`) into `GOOGLE_SHEET_ID`.
5. Share that Sheet with the service account's `client_email` (found inside the JSON key) with **Editor** access.

The app creates its own `Rooms` and `Messages` worksheets (with headers) automatically on first run if they don't already exist.

---

## Running locally

```bash
pip install -r requirements.txt
# set the environment variables above, e.g. via a .env file
python app.py
```
Defaults to `http://localhost:5000`.

## Deploying

Deployed on Render using the included `Procfile`:
```
web: gunicorn --worker-class geventwebsocket.gunicorn.workers.GeventWebSocketWorker -w 1 app:app
```
A single worker is used deliberately — presence/device-count tracking is kept in that worker's memory, so it needs to stay the same process across requests.
