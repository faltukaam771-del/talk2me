const socket = io();

const messagesArea = document.getElementById("messages");
const messageInput = document.getElementById("messageInput");
const sendBtn = document.getElementById("sendBtn");
const typingIndicator = document.getElementById("typingIndicator");
const presenceStatus = document.getElementById("presenceStatus");
const themeToggle = document.getElementById("themeToggle");
const inputArea = document.querySelector(".chat-input-area");
const chatWrapper = document.querySelector(".chat-wrapper");

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

// ---------------- Keep header + input bar pinned above the keyboard ----------------
// Some mobile browsers still try to scroll the page to keep the focused
// input visible even though body scrolling is disabled — this changes
// visualViewport.offsetTop. Fighting that scroll with scrollTo(0,0) (the
// old approach) caused the jitter you saw (position flickering up/down)
// and made the header appear to scroll away, because the header wasn't
// compensating for that offset at all. Instead of fighting the browser,
// we now shift the whole wrapper by exactly that offset so it always
// lines up with whatever is actually visible — header included.
let vvRaf = null;
let vvSettleTimer = null;
function syncInputAreaToViewport() {
  if (!window.visualViewport || !inputArea || !chatWrapper) return;
  if (vvRaf) cancelAnimationFrame(vvRaf);
  vvRaf = requestAnimationFrame(() => {
    const vv = window.visualViewport;
    chatWrapper.style.height = `${vv.height}px`;
    chatWrapper.style.transform = vv.offsetTop ? `translateY(${vv.offsetTop}px)` : "";
    messagesArea.scrollTop = messagesArea.scrollHeight;
  });
}

function scheduleViewportSync() {
  syncInputAreaToViewport(); // apply immediately, keeps it responsive/non-jittery
  // Chrome/Android can fire several resize events while the keyboard is still
  // animating open, and an intermediate (wrong, too-small) height can end up
  // being the last one we saw before things settle. This corrective pass
  // re-measures once the animation has actually finished, so any transient
  // bad value gets overwritten with the real final size.
  clearTimeout(vvSettleTimer);
  vvSettleTimer = setTimeout(syncInputAreaToViewport, 150);
}

if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", scheduleViewportSync);
  window.visualViewport.addEventListener("scroll", scheduleViewportSync);
}

syncInputAreaToViewport();
window.addEventListener("load", syncInputAreaToViewport);
document.addEventListener("DOMContentLoaded", syncInputAreaToViewport);

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
    messagesArea.scrollTop = messagesArea.scrollHeight;
  }
});

socket.on("hide_typing", (data) => {
  if (data.username === OTHER_USERNAME) {
    typingIndicator.innerHTML = "";
    typingIndicator.classList.remove("visible");
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

// ---------------- Particle-burst delete animation ----------------
// The bubble implodes (shrinks + fades) while a burst of small particles
// scatters outward from it, then the row's height collapses so the
// conversation reflows smoothly — all removed from the DOM only once the
// animation actually finishes.

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
    const dy = Math.sin(angle) * distance - 14; // slight upward drift, like dust
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
  if (row.classList.contains("deleting")) return; // already animating out

  const bubble = row.querySelector(".bubble");
  if (bubble) spawnParticles(row, bubble);

  row.classList.add("deleting");
  row.style.maxHeight = `${row.scrollHeight}px`; // lock current height so the collapse transition has something to animate from

  void row.offsetHeight; // force layout so the transition doesn't get skipped

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

// ---------------- Manual refresh (icon inside the input box) ----------------

const refreshBtn = document.getElementById("refreshBtn");

// Prevent the refresh button from ever taking focus away from the message
// input in the first place — this is what actually keeps the keyboard
// open, rather than trying to refocus afterwards (which fails, because by
// the time fetch() resolves, the browser's "user gesture" window has
// expired and .focus() alone can no longer reopen the keyboard).
refreshBtn.addEventListener("mousedown", (e) => e.preventDefault());

async function refreshChat() {
  refreshBtn.classList.add("spinning");
  try {
    const res = await fetch("/messages.json", { headers: { "Accept": "application/json" } });

    if (!res.ok) {
      showToast(`Refresh failed (server said: ${res.status}). Try logging in again if this repeats.`);
      return;
    }

    let data;
    try {
      data = await res.json();
    } catch {
      showToast("Refresh failed: server didn't return valid data.");
      return;
    }

    if (data.error) {
      showToast(data.error);
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
    showToast("Chat refreshed");
  } catch (err) {
    showToast("Refresh failed. Check your connection.");
  } finally {
    setTimeout(() => refreshBtn.classList.remove("spinning"), 400);
  }
}

refreshBtn.addEventListener("click", refreshChat);

// TEMPORARY DEBUG OVERLAY — remove once the keyboard-gap issue is fixed.
const debugBox = document.createElement("div");
debugBox.style.cssText = "position:fixed;top:4px;left:4px;z-index:9999;background:red;color:#fff;font-size:11px;padding:4px 6px;font-family:monospace;white-space:pre;";
document.body.appendChild(debugBox);

function updateDebugBox() {
  if (!window.visualViewport) {
    debugBox.textContent = "No visualViewport API";
    return;
  }
  const vv = window.visualViewport;
  debugBox.textContent =
    `vv.height: ${vv.height}\n` +
    `vv.offsetTop: ${vv.offsetTop}\n` +
    `window.innerHeight: ${window.innerHeight}\n` +
    `chatWrapper height: ${chatWrapper.offsetHeight}\n` +
    `chatWrapper style.height: ${chatWrapper.style.height}\n` +
    `chatWrapper transform: ${chatWrapper.style.transform}`;
}

if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", updateDebugBox);
  window.visualViewport.addEventListener("scroll", updateDebugBox);
}
window.addEventListener("load", updateDebugBox);
updateDebugBox();
setInterval(updateDebugBox, 500); // catch changes even if events don't fire
