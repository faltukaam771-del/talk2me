"""
app.py
------
WhatsApp-style TEXT-ONLY chat web app — SINGLE fixed room.

Flow:
  1. Share the app link with people (e.g. https://your-app.onrender.com/).
  2. Anyone who opens it lands on the join page: they enter their name +
     password (predefined via ADMIN_PASSWORD / USER_PASSWORD in .env).
  3. On success they land on /chat where:
       - Previous chat history is loaded from a Google Sheet (see
         utils/sheets_handler.py for the one-time setup needed for this)
       - New messages are sent/received live via Flask-SocketIO
       - admin can delete any message
       - Both sides see "Active now" / "typing..." status for each other

Photo/video sharing has been removed on purpose — this build is chat-only.

IMPORTANT — deployment note: this app uses WebSockets (Flask-SocketIO),
so it MUST run under a worker that supports them. The Procfile has to use:
  web: gunicorn --worker-class geventwebsocket.gunicorn.workers.GeventWebSocketWorker -w 1 app:app
Using a plain "-k gevent" worker (no "websocket") causes:
  RuntimeError: The gevent-websocket server is not configured appropriately
"""

import os
import socket
import threading
from dotenv import load_dotenv
from flask import Flask, render_template, request, redirect, url_for, session
from flask_socketio import SocketIO, join_room, emit
from werkzeug.exceptions import HTTPException

from utils import sheets_handler as db

load_dotenv()  # reads .env into os.environ — must happen before any os.environ.get() calls below

# ---------------------------------------------------------------------------
# CONFIG
# ---------------------------------------------------------------------------

# Single fixed room — no room creation flow, no per-room passwords.
ROOM_ID = "main"
ROOM_NAME = os.environ.get("ROOM_NAME", "Our Chat")
ALLOWED_USERS = {
    "admin": os.environ["ADMIN_PASSWORD"],
    "user": os.environ["USER_PASSWORD"],
}
ADMIN_USERNAME = "admin"

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "change-this-secret-key")

socketio = SocketIO(app, cors_allowed_origins="*")

try:
    db.init_excel()
except Exception as e:
    print(
        "\nWARNING: Could not connect to Google Sheets on startup.\n"
        "   Make sure GOOGLE_SHEET_ID and GOOGLE_CREDENTIALS_JSON are set "
        "in your .env file (see utils/sheets_handler.py for setup steps).\n"
        f"   Error: {e}\n"
    )

# ---------------------------------------------------------------------------
# IN-MEMORY PRESENCE TRACKING (who's online right now)
# ---------------------------------------------------------------------------
# Resets whenever the app restarts — that's fine, presence is only ever
# meant to reflect "right now" anyway.

_presence_lock = threading.Lock()
online_counts = {}     # username -> number of active socket connections (tabs/devices)
sid_username = {}      # socket sid -> username, so disconnect knows who left


def _online_usernames():
    return sorted([u for u, c in online_counts.items() if c > 0])


def _broadcast_presence():
    socketio.emit("presence_update", {"online_users": _online_usernames()}, room=ROOM_ID)


def format_time_12h(timestamp_str):
    """'2026-07-20 14:05:00' -> '2:05 PM' (falls back to the raw string on
    any unexpected format instead of raising)."""
    try:
        from datetime import datetime as _dt
        dt = _dt.strptime(timestamp_str, "%Y-%m-%d %H:%M:%S")
        return dt.strftime("%I:%M %p").lstrip("0")
    except (ValueError, TypeError):
        return timestamp_str


def ensure_port_available(host, port):
    """Fail early with a clear message if the development port is busy."""
    try:
        with socket.create_connection((host, port), timeout=0.5):
            pass
    except (ConnectionRefusedError, OSError, socket.timeout):
        return

    raise SystemExit(
        f"\nPort {port} is already in use.\n"
        "Stop the other server, or run this app on another port, for example:\n"
        "  $env:PORT=5001; python app.py\n"
    )

# ---------------------------------------------------------------------------
# ERROR HANDLING — a Google Sheets hiccup should show a friendly page, not
# Render/Flask's raw "Internal Server Error" screen.
# ---------------------------------------------------------------------------

@app.errorhandler(Exception)
def handle_uncaught_error(e):
    if isinstance(e, HTTPException):
        return e
    app.logger.exception("Unhandled error")
    return render_template("error.html"), 500


# ---------------------------------------------------------------------------
# ROUTES - JOIN THE ROOM
# ---------------------------------------------------------------------------

@app.route("/", methods=["GET", "POST"])
def join_page():
    if session.get("auth") and request.method == "GET":
        return redirect(url_for("chat_page"))

    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "").strip()

        if not username or not password:
            return render_template("join.html", room_name=ROOM_NAME, error="Please enter both a name and a password.")

        normalized_username = username.lower()
        expected_password = ALLOWED_USERS.get(normalized_username)
        if expected_password is None or password != expected_password:
            return render_template("join.html", room_name=ROOM_NAME, error="Only admin or user are allowed. Please check your username/password.")

        session.clear()
        session["auth"] = normalized_username
        return redirect(url_for("chat_page"))

    return render_template("join.html", room_name=ROOM_NAME)


# ---------------------------------------------------------------------------
# ROUTES - CHAT ROOM
# ---------------------------------------------------------------------------

@app.route("/chat")
def chat_page():
    username = session.get("auth")
    if not username:
        return redirect(url_for("join_page"))

    try:
        history = db.get_messages(ROOM_ID)
        history_error = False
    except Exception:
        app.logger.exception("Failed to load chat history")
        history = []
        history_error = True

    for msg in history:
        msg["display_time"] = format_time_12h(msg.get("timestamp", ""))

    other_username = "user" if username == ADMIN_USERNAME else ADMIN_USERNAME

    return render_template(
        "chat.html",
        room_id=ROOM_ID,
        room_name=ROOM_NAME,
        username=username,
        history=history,
        history_error=history_error,
        is_admin=(username == ADMIN_USERNAME),
        other_username=other_username,
    )


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("join_page"))


# ---------------------------------------------------------------------------
# SOCKET.IO EVENTS - LIVE MESSAGING
# ---------------------------------------------------------------------------

@socketio.on("join")
def handle_join(data):
    username = session.get("auth")
    if not username:
        return
    join_room(ROOM_ID)
    sid_username[request.sid] = username

    with _presence_lock:
        online_counts[username] = online_counts.get(username, 0) + 1

    # No "X joined the chat" announcement at all — presence is shown purely
    # via the "Active now" status in the header (see presence_update below),
    # so refreshing the page never spams the conversation with join messages.
    _broadcast_presence()


@socketio.on("disconnect")
def handle_disconnect():
    username = sid_username.pop(request.sid, None)
    if not username:
        return
    with _presence_lock:
        online_counts[username] = max(0, online_counts.get(username, 0) - 1)
    _broadcast_presence()


@socketio.on("send_message")
def handle_send_message(data):
    username = session.get("auth")
    if not username:
        return
    message = (data.get("message") or "").strip()
    if not message:
        return

    try:
        timestamp, msg_id = db.add_message(ROOM_ID, username, message, msg_type="text")
    except Exception:
        app.logger.exception("Could not save message")
        emit("action_error", {"message": "Message could not be saved. Please try again."})
        return

    payload = {
        "msg_id": msg_id,
        "username": username,
        "message": message,
        "msg_type": "text",
        "file_path": "",
        "timestamp": timestamp,
    }
    emit("receive_message", payload, room=ROOM_ID)
    emit("hide_typing", {"username": username}, room=ROOM_ID, include_self=False)


@socketio.on("delete_message")
def handle_delete_message(data):
    username = session.get("auth")
    if username != ADMIN_USERNAME:
        return  # only admin can delete

    msg_id = data.get("msg_id")
    if not msg_id:
        return

    try:
        deleted = db.delete_message(ROOM_ID, msg_id)
    except Exception:
        app.logger.exception("Could not delete message")
        emit("action_error", {"message": "Delete failed. Please try again."})
        return

    if deleted:
        emit("message_deleted", {"msg_id": msg_id}, room=ROOM_ID)
    else:
        emit("action_error", {"message": "Message not found — it may already be deleted."})


@socketio.on("typing")
def handle_typing(data):
    username = session.get("auth")
    if not username:
        return
    emit("show_typing", {"username": username}, room=ROOM_ID, include_self=False)


@socketio.on("stop_typing")
def handle_stop_typing(data):
    username = session.get("auth")
    if not username:
        return
    emit("hide_typing", {"username": username}, room=ROOM_ID, include_self=False)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    ensure_port_available("127.0.0.1", port)
    # use_reloader=False: on Windows, Flask's debug auto-reloader spawns a
    # second process, and both try to bind the same port with Socket.IO —
    # causing "OSError: [WinError 10048]". Keeping debug=True still gives
    # you full error tracebacks in the browser; it just won't auto-restart
    # on file changes (stop the server with Ctrl+C and rerun manually instead).
    socketio.run(app, host="0.0.0.0", port=port, debug=True, use_reloader=False)
