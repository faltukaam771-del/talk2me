const socket = io();

const messagesArea = document.getElementById("messages");
const messageInput = document.getElementById("messageInput");
const sendBtn = document.getElementById("sendBtn");
const typingIndicator = document.getElementById("typingIndicator");
const presenceStatus = document.getElementById("presenceStatus");
const deviceCount = document.getElementById("deviceCount");
const themeToggle = document.getElementById("themeToggle");
const chatWrapper = document.querySelector(".chat-wrapper");
const header = document.querySelector(".chat-header");
const bottomBar = document.querySelector(".bottom-bar");

// ---------------- Dark mode ----------------

themeToggle.addEventListener("click", () => {
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  if (isDark) {
    document.documentElement.removeAttribute("data-theme");
    localStorage.setItem("theme", "light");
  } else {
    document.documentElement.setAttribute("data-theme", "dark");
    localStorage.setItem("theme", "dark");
  }
});

messagesArea.scrollTop = messagesArea.scrollHeight;

// ---------------- Keyboard-safe layout ----------------
// Header is truly `position: fixed; top: 0` — the keyboard never affects
// the top of the screen, so it never needs to move.
//
// The typing-indicator + input bar are grouped into one `.bottom-bar`,
// also `position: fixed`, and JS lifts that single group up by exactly
// the keyboard's height whenever it opens — instead of the old approach
// of resizing the entire chat-wrapper, which was unreliable because it
// depended on precisely tracking a moving visualViewport height in sync
// with the whole page. Lifting just the bottom bar by a computed offset
// is the same technique production chat apps (Telegram Web, Slack, etc.)
// use, and needs far fewer moving parts to get right.
//
// messages-area fills the full screen (position: absolute, inset 0) and
// gets padding-top/padding-bottom set to the header/bottom-bar's real
// measured heights, so messages never sit hidden underneath either one.

function syncLayoutPadding() {
  if (!header || !bottomBar) return;
  messagesArea.style.paddingTop = `${header.offsetHeight + 14}px`; // +14px gap before the first message
  messagesArea.style.paddingBottom = `${bottomBar.offsetHeight + 12}px`; // +12px breathing room above the input bar
}

function syncKeyboardOffset() {
  if (!window.visualViewport || !bottomBar) return;
  const vv = window.visualViewport;
  const keyboardHeight = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
  bottomBar.style.transform = keyboardHeight > 0 ? `translateY(-${keyboardHeight}px)` : "";
  syncLayoutPadding();
  messagesArea.scrollTop = messagesArea.scrollHeight;
}

if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", syncKeyboardOffset);
  window.visualViewport.addEventListener("scroll", syncKeyboardOffset);
}
window.addEventListener("load", syncKeyboardOffset);
document.addEventListener("DOMContentLoaded", syncKeyboardOffset);
syncLayoutPadding();
syncKeyboardOffset();

socket.on("connect", () => {
  socket.emit("join", { room_id: ROOM_ID, username: USERNAME });
  markVisibleAsRead();
});

function formatTime12h(timestampStr) {
  if (!timestampStr) return "";
  const [datePart, timePart] = timestampStr.split(" ");
  if (!datePart || !timePart) return timestampStr;
  const utcDate = new Date(`${datePart}T${timePart}Z`);
  if (isNaN(utcDate.getTime())) return timestampStr;
  return utcDate.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
}

function tickMarkup(isOwn, status) {
  if (!isOwn) return "";
  const symbol = status === "sent" ? "✓" : "✓✓";
  const readClass = status === "read" ? " read" : "";
  return `<span class="msg-tick${readClass}">${symbol}</span>`;
}

function appendMessage(data) {
  const isOwn = data.username === USERNAME;
  const row = document.createElement("div");
  row.className = `message-row ${isOwn ? "own" : "other"} fade-in`;
  row.dataset.msgid = data.msg_id || "";

  const timePart = formatTime12h(data.timestamp);

  let inner = "";
  if (!isOwn) inner += `<span class="msg-sender">${escapeHtml(data.username)}</span>`;

  inner += `<p class="msg-text">${escapeHtml(data.message)}</p>`;

  const deleteBtn = IS_ADMIN
    ? `<button class="delete-btn" data-msgid="${data.msg_id || ""}" title="Delete message">🗑</button>`
    : "";

  inner += `<span class="msg-meta">${deleteBtn}<span class="msg-time">${timePart}</span>${tickMarkup(isOwn, data.status || "sent")}</span>`;

  row.innerHTML = `<div class="bubble">${inner}</div>`;
  messagesArea.appendChild(row);
  messagesArea.scrollTop = messagesArea.scrollHeight;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

function sendMessage() {
  const text = messageInput.value.trim();
  if (!text) return;
  socket.emit("send_message", { room_id: ROOM_ID, username: USERNAME, message: text });
  socket.emit("stop_typing", { room_id: ROOM_ID, username: USERNAME });
  clearTimeout(typingStopTimer);
  messageInput.value = "";
  messageInput.focus();
}

sendBtn.addEventListener("click", sendMessage);
messageInput.addEventListener("keypress", (e) => {
  if (e.key === "Enter") sendMessage();
});

// ---------------- Typing indicator ----------------

let typingStopTimer;
messageInput.addEventListener("input", () => {
  socket.emit("typing", { room_id: ROOM_ID, username: USERNAME });
  clearTimeout(typingStopTimer);
  typingStopTimer = setTimeout(() => {
    socket.emit("stop_typing", { room_id: ROOM_ID, username: USERNAME });
  }, 1500);
});

messageInput.addEventListener("blur", () => {
  socket.emit("stop_typing", { room_id: ROOM_ID, username: USERNAME });
  clearTimeout(typingStopTimer);
});

// ---------------- Receiving events ----------------

socket.on("receive_message", (data) => {
  appendMessage(data);
  if (data.username !== USERNAME) {
    socket.emit("mark_delivered", { msg_id: data.msg_id });
    if (document.hasFocus()) {
      socket.emit("mark_read", { msg_ids: [data.msg_id] });
    }
  }
});

function markVisibleAsRead() {
  const unread = [...messagesArea.querySelectorAll(".message-row.other")].map(r => r.dataset.msgid).filter(Boolean);
  if (unread.length) socket.emit("mark_read", { msg_ids: unread });
}

window.addEventListener("focus", markVisibleAsRead);

socket.on("status_update", (data) => {
  const ids = data.msg_ids || [];
  ids.forEach((id) => {
    const tick = messagesArea.querySelector(`.message-row[data-msgid="${CSS.escape(id)}"] .msg-tick`);
    if (!tick) return;
    tick.textContent = "✓✓";
    tick.classList.toggle("read", data.status === "read");
  });
});

socket.on("show_typing", (data) => {
  if (data.username === OTHER_USERNAME) {
    typingIndicator.innerHTML = `<span class="typing-dots"><span></span><span></span><span></span></span>`;
    typingIndicator.classList.add("visible");
    requestAnimationFrame(syncLayoutPadding);
    messagesArea.scrollTop = messagesArea.scrollHeight;
  }
});

socket.on("hide_typing", (data) => {
  if (data.username === OTHER_USERNAME) {
    typingIndicator.innerHTML = "";
    typingIndicator.classList.remove("visible");
    requestAnimationFrame(syncLayoutPadding);
  }
});

socket.on("presence_update", (data) => {
  const online = data.online_users || [];
  const counts = data.counts || {};

  if (online.includes(OTHER_USERNAME)) {
    presenceStatus.textContent = "Active now";
    presenceStatus.classList.add("is-online");
  } else {
    presenceStatus.textContent = "Offline";
    presenceStatus.classList.remove("is-online");
  }

  // Device/tab count — shown to both admin and user, e.g. "You: 2 devices · user: 1 device"
  const myCount = counts[USERNAME] || 0;
  const otherCount = counts[OTHER_USERNAME] || 0;
  deviceCount.textContent = `· You ${myCount} · ${OTHER_USERNAME} ${otherCount}`;

  if (kickBtn) kickBtn.style.display = otherCount > 0 ? "flex" : "none";
});

// ---------------- Custom confirm popup (replaces window.confirm()) ----------------

function showConfirm(message, onConfirm) {
  const overlay = document.createElement("div");
  overlay.className = "confirm-overlay";
  overlay.innerHTML = `
    <div class="confirm-card">
      <p class="confirm-message"></p>
      <div class="confirm-actions">
        <button type="button" class="confirm-btn confirm-cancel">Cancel</button>
        <button type="button" class="confirm-btn confirm-ok">Confirm</button>
      </div>
    </div>`;
  overlay.querySelector(".confirm-message").textContent = message;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("show"));

  function close() {
    overlay.classList.remove("show");
    setTimeout(() => overlay.remove(), 200);
  }

  overlay.querySelector(".confirm-cancel").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector(".confirm-ok").addEventListener("click", () => {
    close();
    onConfirm();
  });
}

const kickBtn = document.getElementById("kickBtn");
if (kickBtn) {
  kickBtn.addEventListener("click", () => {
    showConfirm(`Log ${OTHER_USERNAME} out of the chat now?`, () => {
      socket.emit("admin_kick", {});
    });
  });
}

socket.on("kicked", (data) => {
  if (data.username === USERNAME) {
    showToast("You were logged out by the admin.", "warn");
    setTimeout(() => { window.location.href = "/logout"; }, 1100);
  }
});

// ---------------- System-message popup (replaces plain alert()) ----------------
// type: "info" (default, e.g. "Chat refreshed"), "error" (e.g. save/delete
// failed), "warn" (e.g. kicked out) — each gets its own icon + accent color.

const TOAST_ICONS = {
  info: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><line x1="12" y1="8" x2="12" y2="8.01"></line><line x1="12" y1="12" x2="12" y2="16"></line></svg>`,
  error: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12" y2="16.01"></line></svg>`,
  warn: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12" y2="17.01"></line></svg>`,
  delete: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6M14 11v6"></path></svg>`,
};

function showToast(message, type = "info") {
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span class="toast-icon">${TOAST_ICONS[type] || TOAST_ICONS.info}</span><span class="toast-text"></span>`;
  el.querySelector(".toast-text").textContent = message;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

socket.on("action_error", (data) => {
  showToast(data.message || "Kuch gadbad ho gayi.", "error");
});

// ---------------- Particle-burst delete animation ----------------

function spawnParticles(row, bubbleEl) {
  const bubbleRect = bubbleEl.getBoundingClientRect();
  const wrapperRect = chatWrapper.getBoundingClientRect();

  const container = document.createElement("div");
  container.className = "particle-container";
  container.style.left = `${bubbleRect.left - wrapperRect.left}px`;
  container.style.top = `${bubbleRect.top - wrapperRect.top}px`;
  container.style.width = `${bubbleRect.width}px`;
  container.style.height = `${bubbleRect.height}px`;

  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const particleColor = row.classList.contains("own")
    ? (isDark ? "#00a884" : "#25d366")
    : (isDark ? "#8696a0" : "#93a5ad");

  const count = 16;
  for (let i = 0; i < count; i++) {
    const p = document.createElement("span");
    p.className = "msg-particle";
    const x = Math.random() * bubbleRect.width;
    const y = Math.random() * bubbleRect.height;
    const angle = Math.random() * Math.PI * 2;
    const distance = 26 + Math.random() * 46;
    const dx = Math.cos(angle) * distance;
    const dy = Math.sin(angle) * distance - 14;
    const rot = `${Math.random() * 300 - 150}deg`;
    const size = 4 + Math.random() * 4;

    p.style.left = `${x}px`;
    p.style.top = `${y}px`;
    p.style.width = `${size}px`;
    p.style.height = `${size}px`;
    p.style.setProperty("--dx", `${dx}px`);
    p.style.setProperty("--dy", `${dy}px`);
    p.style.setProperty("--rot", rot);
    p.style.background = particleColor;
    p.style.animationDelay = `${Math.random() * 70}ms`;
    container.appendChild(p);
  }

  chatWrapper.appendChild(container);
  setTimeout(() => container.remove(), 750);
}

function removeMessageRow(msgId) {
  const row = messagesArea.querySelector(`.message-row[data-msgid="${CSS.escape(msgId)}"]`);
  if (!row) return;
  if (row.classList.contains("deleting")) return;

  const bubble = row.querySelector(".bubble");
  if (bubble) spawnParticles(row, bubble);

  row.classList.add("deleting");
  row.style.maxHeight = `${row.scrollHeight}px`;

  void row.offsetHeight;

  requestAnimationFrame(() => {
    row.classList.add("deleting-collapse");
  });

  row.addEventListener("transitionend", (e) => {
    if (e.propertyName === "max-height" || e.propertyName === "margin-bottom") {
      row.remove();
    }
  });

  setTimeout(() => { if (row.isConnected) row.remove(); }, 550);
}

socket.on("message_deleted", (data) => {
  removeMessageRow(data.msg_id);
  showToast("Message deleted", "delete");
});

// ---------------- Admin: delete message ----------------

messagesArea.addEventListener("click", (e) => {
  const btn = e.target.closest(".delete-btn");
  if (!btn) return;
  const msgId = btn.dataset.msgid;
  if (!msgId) return;
  showConfirm("Delete this message?", () => {
    socket.emit("delete_message", { room_id: ROOM_ID, msg_id: msgId });
  });
});

// ---------------- Manual refresh (icon inside the input box) ----------------

const refreshBtn = document.getElementById("refreshBtn");

refreshBtn.addEventListener("mousedown", (e) => e.preventDefault());

async function refreshChat() {
  refreshBtn.classList.add("spinning");
  try {
    const res = await fetch("/messages.json", { headers: { "Accept": "application/json" } });

    if (!res.ok) {
      showToast(`Refresh failed (server said: ${res.status}). Try logging in again if this repeats.`, "error");
      return;
    }

    let data;
    try {
      data = await res.json();
    } catch {
      showToast("Refresh failed: server didn't return valid data.", "error");
      return;
    }

    if (data.error) {
      showToast(data.error, "error");
      return;
    }

    messagesArea.innerHTML = "";
    (data.messages || []).forEach((msg) => {
      appendMessage({
        msg_id: msg.msg_id,
        username: msg.username,
        message: msg.message,
        timestamp: msg.timestamp,
        status: msg.status,
      });
    });
    socket.emit("join", { room_id: ROOM_ID, username: USERNAME });
    showToast("Chat refreshed", "info");
  } catch (err) {
    showToast("Refresh failed. Check your connection.", "error");
  } finally {
    setTimeout(() => refreshBtn.classList.remove("spinning"), 400);
  }
}

refreshBtn.addEventListener("click", refreshChat);
