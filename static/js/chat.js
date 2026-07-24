const socket = io();

// ---------------- Keep input bar pinned above the keyboard ----------------
// On mobile browsers (Chrome/Brave), opening the keyboard shrinks the
// "visual viewport" but NOT the layout viewport that `position: fixed`
// elements are measured against — leaving a gap between the input bar
// and the keyboard. This keeps the input bar glued to the actual
// visible area by reading window.visualViewport directly.
const inputArea = document.querySelector(".chat-input-area");

function syncInputAreaToViewport() {
  if (!window.visualViewport || !inputArea) return;
  const vv = window.visualViewport;
  const keyboardGap = window.innerHeight - vv.height - vv.offsetTop;
  inputArea.style.transform = keyboardGap > 0 ? `translateY(-${keyboardGap}px)` : "translateY(0)";
  messagesArea.style.paddingBottom = keyboardGap > 0 ? `${keyboardGap}px` : "";
  messagesArea.scrollTop = messagesArea.scrollHeight;
}

if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", syncInputAreaToViewport);
  window.visualViewport.addEventListener("scroll", syncInputAreaToViewport);
}

const messagesArea = document.getElementById("messages");
const messageInput = document.getElementById("messageInput");
const sendBtn = document.getElementById("sendBtn");
const typingIndicator = document.getElementById("typingIndicator");
const presenceStatus = document.getElementById("presenceStatus");
const themeToggle = document.getElementById("themeToggle");

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

socket.on("connect", () => {
  socket.emit("join", { room_id: ROOM_ID, username: USERNAME });
  // Mark any messages from the other person that are already on screen as read.
  markVisibleAsRead();
});

function formatTime12h(timestampStr) {
  if (!timestampStr) return "";
  const [datePart, timePart] = timestampStr.split(" ");
  if (!datePart || !timePart) return timestampStr;
  const utcDate = new Date(`${datePart}T${timePart}Z`); // stored value is UTC
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
  messageInput.focus(); // keeps the mobile keyboard open after tapping Send
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
    // I received someone else's message -> tell them it was delivered.
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
  }
});

socket.on("hide_typing", (data) => {
  if (data.username === OTHER_USERNAME) {
    typingIndicator.innerHTML = "";
  }
});

socket.on("presence_update", (data) => {
  const online = data.online_users || [];
  if (online.includes(OTHER_USERNAME)) {
    presenceStatus.textContent = "Active now";
    presenceStatus.classList.add("is-online");
  } else {
    presenceStatus.textContent = "Offline";
    presenceStatus.classList.remove("is-online");
  }
});

// ---------------- Toast popup (replaces alert()) ----------------

function showToast(message) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

socket.on("action_error", (data) => {
  showToast(data.message || "Kuch gadbad ho gayi.");
});

socket.on("message_deleted", (data) => {
  const row = messagesArea.querySelector(`.message-row[data-msgid="${CSS.escape(data.msg_id)}"]`);
  if (row) row.remove();
});

// ---------------- Admin: delete message ----------------

messagesArea.addEventListener("click", (e) => {
  const btn = e.target.closest(".delete-btn");
  if (!btn) return;
  const msgId = btn.dataset.msgid;
  if (!msgId) return;
  if (!confirm("Delete this message?")) return;
  socket.emit("delete_message", { room_id: ROOM_ID, msg_id: msgId });
});
