const socket = io();

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

// Scroll to the latest message on load
messagesArea.scrollTop = messagesArea.scrollHeight;

// Join the room's socket namespace — re-run this on EVERY connect (including
// automatic reconnects after a dropped connection), otherwise a reconnected
// socket is never added back to the room server-side and stops receiving
// live messages until a full page refresh.
socket.on("connect", () => {
  socket.emit("join", { room_id: ROOM_ID, username: USERNAME });
});

function formatTime12h(timestampStr) {
  if (!timestampStr) return "";
  const timePart = timestampStr.includes(" ") ? timestampStr.split(" ")[1] : timestampStr;
  const bits = timePart.split(":");
  let hours = parseInt(bits[0], 10);
  const minutes = bits[1] || "00";
  if (isNaN(hours)) return timestampStr;
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  if (hours === 0) hours = 12;
  return `${hours}:${minutes} ${ampm}`;
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

  inner += `<span class="msg-meta">${deleteBtn}<span class="msg-time">${timePart}</span>${isOwn ? '<span class="msg-tick">✓</span>' : ""}</span>`;

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
}

sendBtn.addEventListener("click", sendMessage);
messageInput.addEventListener("keypress", (e) => {
  if (e.key === "Enter") sendMessage();
});

// ---------------- Typing indicator (both directions) ----------------

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
});

socket.on("system_message", (data) => {
  const row = document.createElement("div");
  row.className = "system-message";
  row.textContent = data.message;
  messagesArea.appendChild(row);
  messagesArea.scrollTop = messagesArea.scrollHeight;
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

socket.on("action_error", (data) => {
  alert(data.message || "Kuch gadbad ho gayi.");
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

  // The row itself is removed via the 'message_deleted' socket broadcast
  // once the server confirms the delete; 'action_error' fires if it fails.
  socket.emit("delete_message", { room_id: ROOM_ID, msg_id: msgId });
});
