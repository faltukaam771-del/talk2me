"""
sheets_handler.py
------------------
Chat data lives in a Google Sheet so it survives Render redeploys/restarts.

--- ONE-TIME SETUP ---
1. Google Cloud Console -> new project.
2. Enable APIs: "Google Sheets API" AND "Google Drive API".
3. IAM & Admin -> Service Accounts -> Create Service Account -> Keys ->
   Add Key -> JSON. Copy the whole JSON content.
4. Create a Google Sheet, copy its ID from the URL:
   https://docs.google.com/spreadsheets/d/<THIS PART>/edit
5. Share that Sheet with the service account's "client_email" -> Editor access.
6. Set env vars: GOOGLE_SHEET_ID and GOOGLE_CREDENTIALS_JSON (the JSON as one line).

--- WHY WORKSHEET LOOKUPS ARE CACHED ---
Looking up a worksheet by name costs 2-3 Google Sheets API calls. Doing
that on every add_message()/get_messages() call used to blow through
Google's free-tier per-minute quota and crash the app with an uncaught
gspread.exceptions.APIError. The worksheet handle is now looked up ONCE
at startup and cached; every call below reuses it, with retry-with-backoff
if a call still fails.
"""

import os
import json
import time
import uuid
import random
import logging
import threading
from datetime import datetime

import gspread
from google.oauth2.service_account import Credentials

log = logging.getLogger(__name__)

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]

ROOMS_HEADERS = ["room_id", "room_name", "password_hash", "created_at"]
MESSAGES_HEADERS = ["msg_id", "room_id", "username", "message", "msg_type", "file_path", "timestamp"]

# Only the most recent HISTORY_LIMIT messages are ever loaded/shown. Without
# this, get_messages() re-reads the ENTIRE sheet on every /chat page load —
# as the sheet grows over weeks of chatting this gets slower and slower and
# eventually starts timing out, which is what shows up as "chat history
# won't load". Bounding the read keeps every page load fast no matter how
# long the chat history gets.
HISTORY_LIMIT = 500

_lock = threading.Lock()
_client = None
_spreadsheet = None
_rooms_ws = None
_messages_ws = None

# Last successfully loaded messages per room. If a live Sheets read fails
# (rate limit, transient network blip, momentary auth hiccup), we serve this
# instead of a blank/broken chat — the person still sees their history and
# can keep chatting live; the next successful read refreshes the cache.
_last_good_messages = {}
_cache_lock = threading.Lock()


def _get_client(force_new=False):
    global _client
    if _client is None or force_new:
        creds_json = os.environ.get("GOOGLE_CREDENTIALS_JSON")
        if not creds_json:
            raise RuntimeError("GOOGLE_CREDENTIALS_JSON environment variable is not set.")
        creds_dict = json.loads(creds_json)
        creds = Credentials.from_service_account_info(creds_dict, scopes=SCOPES)
        _client = gspread.authorize(creds)
    return _client


def _get_spreadsheet(force_new=False):
    global _spreadsheet
    if _spreadsheet is None or force_new:
        sheet_id = os.environ.get("GOOGLE_SHEET_ID")
        if not sheet_id:
            raise RuntimeError("GOOGLE_SHEET_ID environment variable is not set.")
        _spreadsheet = _get_client(force_new=force_new).open_by_key(sheet_id)
    return _spreadsheet


def _create_worksheet_handle(title, headers, force_new=False):
    ss = _get_spreadsheet(force_new=force_new)
    try:
        ws = ss.worksheet(title)
    except gspread.exceptions.WorksheetNotFound:
        ws = ss.add_worksheet(title=title, rows=2000, cols=len(headers))
        ws.append_row(headers)
        return ws

    first_row = ws.row_values(1)
    if not first_row:
        ws.insert_row(headers, 1)
    elif len(first_row) < len(headers):
        ws.update("A1", [headers])
    return ws


def _with_retry(fn, *args, retries=4, _refresh_fn=None, **kwargs):
    """Retries with backoff + jitter. From the 2nd failed attempt onward it
    forces a full reconnect (new client/spreadsheet/worksheet handle) before
    retrying — this is what recovers from a stale/expired session instead of
    repeatedly failing the same way until the whole request times out."""
    last_err = None
    for attempt in range(retries):
        try:
            return fn(*args, **kwargs)
        except Exception as e:
            last_err = e
            log.warning("Sheets call failed (attempt %d/%d): %s", attempt + 1, retries, e)
            if attempt >= 1 and _refresh_fn is not None:
                try:
                    _refresh_fn()
                except Exception:
                    pass
            if attempt < retries - 1:
                time.sleep(0.5 * (2 ** attempt) + random.uniform(0, 0.4))
    raise last_err


def init_excel():
    global _rooms_ws, _messages_ws
    _rooms_ws = _create_worksheet_handle("Rooms", ROOMS_HEADERS)
    _messages_ws = _create_worksheet_handle("Messages", MESSAGES_HEADERS)


def _refresh_messages_ws():
    global _messages_ws
    _messages_ws = _create_worksheet_handle("Messages", MESSAGES_HEADERS, force_new=True)


def _refresh_rooms_ws():
    global _rooms_ws
    _rooms_ws = _create_worksheet_handle("Rooms", ROOMS_HEADERS, force_new=True)


def _messages_worksheet():
    if _messages_ws is None:
        init_excel()
    return _messages_ws


def _rooms_worksheet():
    if _rooms_ws is None:
        init_excel()
    return _rooms_ws


# ---------------------------------------------------------------------------
# ROOM OPERATIONS (kept for compatibility — unused by the single-room app)
# ---------------------------------------------------------------------------

def create_room(room_id, room_name, password_hash):
    with _lock:
        ws = _rooms_worksheet()
        _with_retry(ws.append_row, [room_id, room_name, password_hash,
                                     datetime.now().strftime("%Y-%m-%d %H:%M:%S")],
                    _refresh_fn=_refresh_rooms_ws)


def get_room(room_id):
    with _lock:
        ws = _rooms_worksheet()
        records = _with_retry(ws.get_all_values, _refresh_fn=_refresh_rooms_ws)[1:]
        for row in records:
            if row and row[0] == room_id:
                return {"room_id": row[0], "room_name": row[1], "password_hash": row[2], "created_at": row[3]}
    return None


def room_exists(room_id):
    return get_room(room_id) is not None


# ---------------------------------------------------------------------------
# MESSAGE OPERATIONS
# ---------------------------------------------------------------------------

def add_message(room_id, username, message, msg_type="text", file_path=""):
    """Returns (timestamp, msg_id)."""
    msg_id = uuid.uuid4().hex[:12]
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with _lock:
        ws = _messages_worksheet()
        _with_retry(
            ws.append_row,
            [msg_id, room_id, username, message, msg_type, file_path, timestamp],
            _refresh_fn=_refresh_messages_ws,
        )
    with _cache_lock:
        cached = _last_good_messages.get(room_id)
        if cached is not None:
            cached.append({
                "msg_id": msg_id, "username": username, "message": message,
                "msg_type": msg_type or "text", "file_path": file_path, "timestamp": timestamp,
            })
            _last_good_messages[room_id] = cached[-HISTORY_LIMIT:]
    return timestamp, msg_id


def _parse_rows(records, room_id, id_offset=0):
    messages = []
    for idx, row in enumerate(records):
        if not row:
            continue
        if len(row) < len(MESSAGES_HEADERS):
            row = row + [""] * (len(MESSAGES_HEADERS) - len(row))
        msg_id, r_room, username, message, msg_type, file_path, timestamp = row[:7]
        if r_room != room_id:
            continue
        if not msg_id:
            msg_id = f"legacy-{idx + id_offset}"
        messages.append({
            "msg_id": msg_id,
            "username": username,
            "message": message,
            "msg_type": msg_type or "text",
            "file_path": file_path,
            "timestamp": timestamp,
        })
    return messages


def get_messages(room_id, limit=HISTORY_LIMIT):
    """Loads only the most recent `limit` messages. Falls back to the last
    successfully loaded copy if the live Sheets read fails, so a transient
    hiccup shows old-but-present history instead of a broken/empty chat."""
    try:
        with _lock:
            ws = _messages_worksheet()
            # Column A (msg_id) only — cheap way to know how many data rows
            # exist without pulling the whole sheet across the wire.
            id_col = _with_retry(ws.col_values, 1, _refresh_fn=_refresh_messages_ws)
            total_rows = len(id_col)  # includes header row

            if total_rows <= 1:
                messages = []
            else:
                data_row_count = total_rows - 1
                start_row = (total_rows - limit + 1) if data_row_count > limit else 2
                start_row = max(2, start_row)
                cell_range = f"A{start_row}:G{total_rows}"
                values = _with_retry(ws.get, cell_range, _refresh_fn=_refresh_messages_ws)
                messages = _parse_rows(values, room_id, id_offset=start_row - 2)
    except Exception:
        log.exception("get_messages failed for room %s", room_id)
        with _cache_lock:
            cached = _last_good_messages.get(room_id)
        if cached is not None:
            return cached
        raise

    with _cache_lock:
        _last_good_messages[room_id] = messages
    return messages


def delete_message(room_id, msg_id):
    """Deletes the row matching (room_id, msg_id). Returns True if deleted."""
    with _lock:
        ws = _messages_worksheet()
        all_values = _with_retry(ws.get_all_values, _refresh_fn=_refresh_messages_ws)
        data_rows = all_values[1:]

        target_index = None
        if isinstance(msg_id, str) and msg_id.startswith("legacy-"):
            try:
                legacy_idx = int(msg_id.split("-", 1)[1])
            except ValueError:
                legacy_idx = None
            if legacy_idx is not None and 0 <= legacy_idx < len(data_rows):
                row = data_rows[legacy_idx]
                if row and len(row) > 1 and row[1] == room_id:
                    target_index = legacy_idx
        else:
            for idx, row in enumerate(data_rows):
                if row and len(row) > 1 and row[0] == msg_id and row[1] == room_id:
                    target_index = idx
                    break

        if target_index is None:
            return False

        sheet_row_number = target_index + 2
        _with_retry(ws.delete_rows, sheet_row_number, _refresh_fn=_refresh_messages_ws)
    with _cache_lock:
        cached = _last_good_messages.get(room_id)
        if cached is not None:
            _last_good_messages[room_id] = [m for m in cached if m["msg_id"] != msg_id]
    return True
