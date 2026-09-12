const state = {
  settingsRevision: 0,
  calendarRevision: 0,
  loginTimer: null,
  loginAttempt: null,
  account: null,
  settingsDocument: {},
  calendarEditor: null,
  calendarDirty: false,
  cookieStored: false,
  pushplusStored: false,
  aiFiles: [],
  aiAbortController: null,
  aiProgressTimer: null,
  attendanceRunning: false,
};
const $ = (selector) => document.querySelector(selector);
const syncChannel = typeof BroadcastChannel === "function" ? new BroadcastChannel("autocheck-cloud-sync") : null;
let aiRefreshTimer = null;

function safeTime(value, fallback) {
  return /^\d{2}:\d{2}$/.test(String(value ?? "")) ? String(value) : fallback;
}

function formatShanghai(value) {
  if (!value) return "时间未知";
  const raw = String(value);
  const date = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw.replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) return raw;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(date);
}

state.calendarEditor = window.CalendarUI.create("#calendar-editor", (document) => {
  state.calendarDirty = true;
  $("#calendar-json").value = JSON.stringify(document, null, 2);
  $("#calendar-dirty").textContent = "有改动尚未保存";
  $("#calendar-dirty").classList.add("dirty");
  renderLocationOptions(document, $("#default-location")?.value);
  syncAiContextPreview(document);
});

function notice(message, type = "") {
  const target = $("#notice");
  target.textContent = message;
  target.className = `notice ${type}`.trim();
}

function showOperation(message, type = "success", title = "操作完成") {
  const dialog = $("#operation-dialog");
  $("#operation-title").textContent = title;
  $("#operation-message").textContent = message;
  $("#operation-icon").textContent = type === "error" ? "!" : "✓";
  dialog.className = `operation-dialog ${type}`;
  if (dialog.open) return;
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function report(message, type = "success", title) {
  notice(message, type);
  showOperation(message, type, title ?? (type === "error" ? "操作遇到问题" : "操作完成"));
}

$("#operation-close").addEventListener("click", () => $("#operation-dialog").close());

async function api(path, options = {}) {
  const response = await fetch(path, { cache: "no-store", ...options });
  const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
  return payload;
}

function switchPanel(name) {
  document.querySelectorAll(".step").forEach((button) => button.classList.toggle("active", button.dataset.panel === name));
  document.querySelectorAll(".panel").forEach((panel) => panel.classList.toggle("active", panel.id === `panel-${name}`));
  if (name === "ai" && state.account) refreshAiConversation().catch((error) => notice(error.message, "error"));
  if (name === "admin" && state.account?.role === "admin") loadAdminFeedback().catch((error) => notice(error.message, "error"));
}

function broadcastUpdate(kind) {
  syncChannel?.postMessage({ kind, at: Date.now() });
}

async function refreshAiConversation(options = {}) {
  const conversation = await api("/api/ai/conversation");
  renderAiConversation(conversation, options);
  return conversation;
}

function scheduleAiRefresh() {
  clearTimeout(aiRefreshTimer);
  aiRefreshTimer = setTimeout(() => refreshAiConversation().catch(() => {}), 250);
}

function renderLocationOptions(calendar, selected) {
  const select = $("#default-location");
  const locations = Array.isArray(calendar?.locations) ? calendar.locations : [];
  select.replaceChildren(...locations.map((location) => {
    const option = document.createElement("option");
    option.value = location.name;
    option.textContent = location.name;
    option.selected = location.name === selected;
    return option;
  }));
  if (!locations.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "请先建立坐标组";
    select.append(option);
  }
}

async function ensureAccount() {
  const result = await api("/api/account/me");
  const account = result.account;
  state.account = account;
  $("#account-chip").textContent = account.display_name ?? account.email ?? "已登录";
  $("#profile-account").textContent = account.login_name ?? account.display_name ?? "已登录";
  $("#profile-status").textContent = account.status === "active" ? "正常" : account.status;
  if (account.role === "admin") {
    document.querySelectorAll(".admin-only").forEach((element) => { element.hidden = false; });
  }
}

function authMessage(message, error = false) {
  const target = $("#auth-message");
  target.textContent = message;
  target.className = error ? "auth-message error" : "auth-message";
}

function showApp() {
  $("#auth-gate").hidden = true;
  $("#app-shell").hidden = false;
}

async function enterApp() {
  showApp();
  await ensureAccount();
  await loadData();
  notice("配置已加载，可以继续设置或查看签到状态。", "success");
}

document.querySelectorAll("[data-auth-panel]").forEach((button) => button.addEventListener("click", () => {
  const name = button.dataset.authPanel;
  document.querySelectorAll("[data-auth-panel]").forEach((item) => item.classList.toggle("active", item === button));
  document.querySelectorAll(".auth-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `auth-${name}`));
  authMessage(name === "register" ? "注册后会生成一次性恢复码。" : "密码不会以明文保存。");
}));

$("#auth-login").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ loginName: $("#login-name").value, password: $("#login-password").value }),
    });
    await enterApp();
  } catch (error) { authMessage(error.message, true); }
});

$("#auth-register").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await api("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loginName: $("#register-name").value,
        password: $("#register-password").value,
      }),
    });
    document.querySelectorAll(".auth-panel, .auth-tabs").forEach((item) => { item.hidden = true; });
    $("#new-recovery-code").textContent = result.recoveryCode;
    $("#recovery-card").hidden = false;
    authMessage("账户已创建。先把恢复码放好，再继续。 ");
  } catch (error) { authMessage(error.message, true); }
});

$("#auth-recover").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await api("/api/auth/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loginName: $("#recover-name").value,
        recoveryCode: $("#recover-code").value,
        newPassword: $("#recover-password").value,
      }),
    });
    document.querySelectorAll(".auth-panel, .auth-tabs").forEach((item) => { item.hidden = true; });
    $("#new-recovery-code").textContent = result.recoveryCode;
    $("#recovery-card").hidden = false;
    authMessage("密码已更新，旧会话已全部退出。请保存新的恢复码。");
  } catch (error) { authMessage(error.message, true); }
});

$("#continue-after-recovery").addEventListener("click", () => enterApp().catch((error) => authMessage(error.message, true)));

$("#account-chip").addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST" });
    location.reload();
  } catch (error) { report(error.message, "error"); }
});

function settingsFromForm() {
  const intervalMinutes = Number($("#interval").value);
  const windows = [...document.querySelectorAll(".polling-window-row")].map((row) => ({
    start: row.querySelector("[data-window-start]").value,
    end: row.querySelector("[data-window-end]").value,
  }));
  for (const [index, window] of windows.entries()) {
    const [startHour, startMinute] = window.start.split(":").map(Number);
    const [endHour, endMinute] = window.end.split(":").map(Number);
    let duration = endHour * 60 + endMinute - startHour * 60 - startMinute;
    if (duration <= 0) duration += 24 * 60;
    if (duration < intervalMinutes || duration % intervalMinutes !== 0) {
      throw new Error(`第 ${index + 1} 个时间段的长度必须是轮询间隔的整数倍`);
    }
  }
  return {
    ...state.settingsDocument,
    enabled: state.attendanceRunning,
    attendanceEnabled: state.attendanceRunning,
    username: state.account?.login_name ?? state.account?.display_name ?? "",
    classes: state.settingsDocument.classes ?? [],
    calendarWindowMinutes: Number($("#calendar-window").value),
    polling: {
      everyMinutes: intervalMinutes,
      windows,
      locationGroup: $("#default-location").value,
    },
  };
}

function renderPollingWindows(windows) {
  const normalized = Array.isArray(windows) && windows.length
    ? windows
    : [{ start: "06:00", end: "23:00" }];
  $("#polling-window-list").innerHTML = normalized.map((window, index) => `
    <div class="polling-window-row">
      <span class="window-number">${index + 1}</span>
      <div class="window-time-fields">
        <label><span>开始</span><input data-window-start type="time" value="${safeTime(window.start, "06:00")}"></label>
        <label><span>结束</span><input data-window-end type="time" value="${safeTime(window.end, "23:00")}"></label>
      </div>
      <button class="danger-link" type="button" data-remove-window="${index}" ${normalized.length === 1 ? "disabled" : ""}>删除</button>
    </div>
  `).join("");
}

function renderCookieState(stored) {
  state.cookieStored = Boolean(stored);
  $("#cookie-state").textContent = stored ? "Cookie 已储存" : "尚未登录";
  $("#cookie-summary").textContent = stored
    ? "Cookie 已加密储存。需要换班级魔方账号时再点击切换。"
    : "扫码登录后会自动保存 Cookie，并尝试识别班级。";
  $("#start-login").textContent = stored ? "切换账号" : "扫码登录";
  if (stored && !state.loginAttempt) {
    $("#qr-stage").hidden = true;
    $("#qr-preview").removeAttribute("src");
  }
}

function renderPushplusState(stored, editing = false) {
  state.pushplusStored = Boolean(stored);
  $("#pushplus-saved").hidden = !stored || editing;
  $("#pushplus-editor").hidden = stored && !editing;
  $("#test-pushplus").hidden = !stored;
}

function fillSettings(settings) {
  state.attendanceRunning = Boolean(settings.enabled && settings.attendanceEnabled);
  renderAttendanceControl();
  $("#calendar-window").value = settings.calendarWindowMinutes ?? 20;
  $("#interval").value = settings.polling?.everyMinutes ?? 5;
  renderPollingWindows(settings.polling?.windows);
}

function renderAttendanceControl() {
  const button = $("#start-attendance");
  button.textContent = state.attendanceRunning ? "停止签到" : "启动签到";
  button.classList.toggle("primary", !state.attendanceRunning);
  button.classList.toggle("stop-button", state.attendanceRunning);
}

async function loadData() {
  const [settings, calendar, credentials, attendance, ai] = await Promise.all([
    api("/api/documents/settings"),
    api("/api/documents/calendar"),
    api("/api/credentials"),
    api("/api/attendance/logs"),
    api("/api/ai/conversation"),
  ]);
  state.settingsRevision = settings.revision;
  state.calendarRevision = calendar.revision;
  state.settingsDocument = settings.document;
  fillSettings(settings.document);
  const classes = settings.document.classes ?? [];
  $("#profile-classes").textContent = classes.length ? classes.join("、") : "扫码后自动获取";
  $("#check-class-label").textContent = classes.length
    ? `将检查班级：${classes.join("、")}`
    : "扫码后自动识别班级";
  state.calendarEditor.setDocument(
    calendar.document,
    state.account?.login_name ?? state.account?.display_name ?? "当前用户",
    classes,
  );
  renderLocationOptions(calendar.document, settings.document.polling?.locationGroup);
  $("#calendar-json").value = JSON.stringify(calendar.document, null, 2);
  $("#settings-revision").textContent = "配置已同步";
  $("#calendar-revision").textContent = "日历已同步";
  $("#calendar-dirty").textContent = "所有改动都已保存";
  $("#calendar-dirty").classList.remove("dirty");
  state.calendarDirty = false;
  renderCookieState(credentials.cookie.stored);
  renderPushplusState(credentials.pushplus.stored);
  renderAttendanceLogs(attendance.logs);
  renderAiConversation(ai);
  await loadMyFeedback();
  if (state.account?.role === "admin") {
    loadAdminUsers().catch((error) => notice(error.message, "error"));
    loadAdminFeedback().catch((error) => notice(error.message, "error"));
  }
}

function renderLogColumn(outcome, items) {
  const ids = { success: "success-log", failure: "failure-log", no_task: "no-task-log" };
  const countIds = { success: "success-count", failure: "failure-count", no_task: "no-task-count" };
  const list = $(`#${ids[outcome]}`);
  $(`#${countIds[outcome]}`).textContent = String(items.length);
  if (!items.length) {
    list.innerHTML = `<p>还没有${outcome === "success" ? "成功" : outcome === "failure" ? "失败" : "无任务"}记录。</p>`;
    return;
  }
  list.replaceChildren(...items.map((item) => {
    const row = document.createElement("div");
    row.className = "log-item";
    const result = document.createElement("strong");
    result.textContent = item.taskId ? `班级 ${item.classId} · 任务 ${item.taskId}` : `班级 ${item.classId}`;
    const detail = document.createElement("p");
    detail.textContent = item.resultText;
    const time = document.createElement("span");
    time.textContent = `${formatShanghai(item.attemptedAt)} · ${item.source === "scheduler" ? "自动轮询" : "手动测试"}`;
    row.append(result, detail, time);
    return row;
  }));
}

function renderAttendanceLogs(logs = {}) {
  renderLogColumn("success", logs.success ?? []);
  renderLogColumn("failure", logs.failure ?? []);
  renderLogColumn("no_task", logs.no_task ?? []);
}

async function loadAdminUsers() {
  const result = await api("/api/admin/users");
  const target = $("#admin-users");
  target.replaceChildren(...result.users.map((user) => {
    const button = document.createElement("button");
    button.className = "admin-user-card";
    button.dataset.accountId = user.id;
    button.classList.toggle("high-risk", user.ai.highRisk);
    button.innerHTML = `<strong>${user.displayName}</strong><span>${user.status} · ${user.role}${user.ai.highRisk ? " · 高危" : ""}</span><small>AI ${user.ai.todayMessages} 条 · 信誉 ${user.ai.reputation.toFixed(1)} · ${formatBytes(user.ai.storageBytes)}</small>`;
    return button;
  }));
}

const feedbackCategoryLabel = {
  bug: "功能异常", suggestion: "功能建议", question: "使用问题", other: "其他",
};

function appendFeedbackImages(card, item) {
  if (!item.image_count) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "button soft";
  button.textContent = `查看截图（${item.image_count}）`;
  const gallery = document.createElement("div");
  gallery.className = "feedback-images";
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const result = await api(`/api/feedback/${encodeURIComponent(item.id)}/images`);
      gallery.replaceChildren(...result.images.map((src, index) => {
        const details = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = `截图 ${index + 1}（点击展开）`;
        const img = document.createElement("img");
        img.src = src;
        img.alt = `反馈截图 ${index + 1}`;
        details.append(summary, img);
        return details;
      }));
      button.remove();
    } catch (error) { report(error.message, "error", "截图加载失败"); button.disabled = false; }
  });
  card.append(button, gallery);
}

async function loadAdminFeedback() {
  const result = await api("/api/admin/feedback");
  const target = $("#admin-feedback");
  if (!result.feedback.length) {
    target.textContent = "还没有用户反馈。";
    return;
  }
  target.replaceChildren(...result.feedback.map((item) => {
    const card = document.createElement("article");
    card.className = "feedback-item";
    const title = document.createElement("strong");
    title.textContent = item.subject;
    const meta = document.createElement("span");
    meta.textContent = `${feedbackCategoryLabel[item.category] ?? "其他"} · ${item.display_name}（${item.login_name}）· ${formatShanghai(item.created_at)}`;
    const content = document.createElement("p");
    content.textContent = item.content;
    const reply = document.createElement("textarea");
    reply.placeholder = "回复用户...";
    reply.value = item.admin_reply ?? "";
    reply.maxLength = 2000;
    const send = document.createElement("button");
    send.className = "button soft";
    send.textContent = item.admin_reply ? "更新回复" : "发送回复";
    send.addEventListener("click", async () => {
      send.disabled = true;
      try {
        await api(`/api/admin/feedback/${encodeURIComponent(item.id)}/reply`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reply: reply.value }),
        });
        report("回复已发送给用户。", "success");
        await loadAdminFeedback();
      } catch (error) { report(error.message, "error", "回复发送失败"); }
      finally { send.disabled = false; }
    });
    if (item.admin_reply) {
      const replyTime = document.createElement("span");
      replyTime.textContent = `上次回复：${formatShanghai(item.admin_reply_at)}`;
      card.append(title, meta, content, replyTime, reply, send);
    } else card.append(title, meta, content, reply, send);
    appendFeedbackImages(card, item);
    return card;
  }));
}

async function loadMyFeedback() {
  const result = await api("/api/feedback");
  const target = $("#my-feedback");
  if (!result.feedback.length) { target.textContent = "你还没有提交反馈。"; return; }
  target.replaceChildren(...result.feedback.map((item) => {
    const card = document.createElement("article");
    card.className = "feedback-item";
    const title = document.createElement("strong");
    title.textContent = item.subject;
    const content = document.createElement("p");
    content.textContent = item.content;
    card.append(title, content);
    appendFeedbackImages(card, item);
    if (item.admin_reply) {
      const reply = document.createElement("p");
      reply.className = "feedback-reply";
      reply.textContent = `管理员回复：${item.admin_reply}`;
      card.append(reply);
    }
    return card;
  }));
}

function formatBytes(value) {
  const bytes = Number(value ?? 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function loadAdminDetail(accountId) {
  const result = await api(`/api/admin/users/${encodeURIComponent(accountId)}`);
  const user = result.user;
  $("#admin-detail").innerHTML = `
    <h3>${user.displayName}</h3>
    <dl><dt>账户 ID</dt><dd>${user.id}</dd><dt>账户状态</dt><dd>${user.status}${user.statusReason ? `（${user.statusReason}）` : ""}</dd><dt>签到服务</dt><dd>${user.settings?.enabled && user.settings?.attendanceEnabled ? "运行中" : "已停止"}</dd><dt>班级</dt><dd>${(user.settings?.classes ?? []).join("、") || "未识别"}</dd><dt>AI 信誉</dt><dd>${user.ai.reputation.toFixed(1)}${user.ai.highRisk ? " · 高危" : ""}</dd><dt>今日 AI</dt><dd>${user.ai.todayMessages} 条 / ${user.ai.todayNeurons.toFixed(1)} Neurons</dd><dt>累计 Token</dt><dd>${user.ai.totalInputTokens} 输入 / ${user.ai.totalOutputTokens} 输出</dd><dt>近似数据量</dt><dd>${formatBytes(user.ai.storageBytes)}</dd><dt>恢复密钥</dt><dd id="admin-recovery-code">${user.recovery.revealAvailable ? "可受控查看" : "历史账号未保存明文"}</dd></dl>
    <div class="admin-actions">
      <button class="button soft" data-admin-action="recovery" data-account-id="${user.id}" ${user.recovery.revealAvailable ? "" : "disabled"}>显示恢复密钥</button>
      <button class="button soft" data-admin-action="rotate-recovery" data-account-id="${user.id}" data-login-name="${user.loginName}">${user.recovery.revealAvailable ? "重新生成恢复密钥" : "生成可查看的恢复密钥"}</button>
      <button class="button soft" data-admin-action="${user.status === "suspended" ? "activate" : "suspend"}" data-account-id="${user.id}">${user.status === "suspended" ? "解除封禁" : "封禁用户"}</button>
      <button class="button danger-button" data-admin-action="delete" data-account-id="${user.id}" data-login-name="${user.loginName}">删除用户</button>
    </div>
    <h4>最近 AI 评分</h4><div class="admin-score-preview">${result.aiScores.map((item) => `<p><strong>${item.score}</strong> ${item.score_reason} · ${formatShanghai(item.created_at)}</p>`).join("") || "暂无评分"}</div>
    <h4>AI 对话诊断</h4><div class="admin-log-preview" id="admin-ai-diagnostics">${user.ai.diagnosticOptIn ? "正在加载用户授权的对话……" : "该用户未授权查看对话内容。"}</div>
    <h4>最近日志</h4><div class="admin-log-preview">${result.logs.map((log) => `<p><strong>${log.outcome}</strong> ${log.class_id}${log.task_id ? ` / ${log.task_id}` : ""} · ${formatShanghai(log.attempted_at)}</p>`).join("") || "暂无日志"}</div>`;
  if (user.ai.diagnosticOptIn) {
    const target = $("#admin-ai-diagnostics");
    target.replaceChildren(...result.aiMessages.map((message) => {
      const item = document.createElement("p");
      item.textContent = `${message.role === "user" ? "用户" : "AI"} · ${formatShanghai(message.created_at)}\n${message.content}`;
      return item;
    }));
    if (!result.aiMessages.length) target.textContent = "暂无可供诊断的对话。";
  }
}

function renderAiConversation(conversation, options = {}) {
  state.aiConversation = conversation;
  $("#ai-model-state").textContent = `多轮对话 · ${conversation.model.split("/").pop()}`;
  $("#ai-quota-state").textContent = conversation.quota.adminUnlimited
    ? `今天已使用 ${conversation.quota.usedMessages} 条`
    : `今天已使用 ${conversation.quota.usedMessages} 条`;
  $("#ai-reputation-state").textContent = `信誉 ${conversation.reputation.score.toFixed(1)}${conversation.reputation.highRisk ? " · 高危" : ""}`;
  $("#ai-reputation-state").classList.toggle("risk", conversation.reputation.highRisk);
  $("#ai-reputation-value").textContent = conversation.reputation.score.toFixed(1);
  $("#ai-reputation-bar").style.width = `${Math.max(0, Math.min(100, conversation.reputation.score))}%`;
  $(".ai-reputation-card").classList.toggle("risk", conversation.reputation.highRisk);
  $(".vision-license").hidden = state.account?.role !== "admin" || Boolean(conversation.vision?.enabled);
  renderAiQuota(conversation.quota);
  $("#ai-memory").value = conversation.memory ?? "# 用户记忆";
  $("#ai-diagnostic-consent").checked = Boolean(conversation.diagnosticOptIn);
  $("#ai-auto-summary").textContent = conversation.autoSummary || "暂无；对话较长后自动生成。";
  renderAiContext(conversation.context);
  const chat = $("#ai-chat");
  const messages = conversation.messages ?? [];
  const bubbles = messages.map((message) => {
    const bubble = document.createElement("div");
    bubble.className = `ai-bubble ${message.role}`;
    const name = document.createElement("strong");
    name.textContent = message.role === "user" ? "你" : message.metadata?.system ? "系统" : "日历搭子";
    const content = document.createElement("p");
    content.textContent = message.role === "user" && message.content.includes("[附件提取文本]")
      ? `${message.content.split("[附件提取文本]")[0].trim()}\n（已附加文本文件）`
      : message.content;
    const time = document.createElement("time");
    time.textContent = message.displayTime ?? formatShanghai(message.createdAt);
    bubble.append(name, content);
    if (message.role === "assistant" && Number.isFinite(Number(message.metadata?.score))) {
      const score = document.createElement("span");
      score.className = `ai-score ${Number(message.metadata.score) < 70 ? "risk" : ""}`;
      score.textContent = `本轮评分 ${message.metadata.score}`;
      score.title = message.metadata.scoreReason || "日历 AI 自动评估";
      bubble.append(score);
    } else if (message.role === "assistant" && message.metadata?.scoreExempt) {
      const score = document.createElement("span");
      score.className = "ai-score";
      score.textContent = "本轮不计入信誉";
      score.title = message.metadata.scoreReason || "服务异常不影响信誉";
      bubble.append(score);
    }
    bubble.append(time);
    return bubble;
  });
  if (!messages.length) {
    const welcome = document.createElement("div");
    welcome.className = "ai-bubble assistant";
    welcome.innerHTML = "<strong>日历搭子</strong><p>先补全上方基础资料，再把课表交给我。信息不清楚时我会先问。</p>";
    bubbles.push(welcome);
  }
  if (conversation.activeTurn) {
    const thinking = document.createElement("div");
    thinking.className = "ai-bubble assistant ai-thinking";
    thinking.dataset.turnId = conversation.activeTurn.id;
    thinking.innerHTML = `<strong>日历搭子</strong><p><i></i><i></i><i></i><span>${conversation.activeTurn.phase || "思考中"}</span></p><small>你的提问已经保存；即使失败也会留下答复。</small>`;
    bubbles.push(thinking);
  }
  if (conversation.pending) bubbles.push(renderAiProposal(conversation.pending));
  chat.replaceChildren(...bubbles);
  chat.scrollTop = chat.scrollHeight;
  if (options.animateLatest) animateLatestAssistant(chat);
}

function renderAiQuota(quota) {
  const personalBar = $("#ai-personal-quota-bar");
  if (quota.adminUnlimited) {
    $("#ai-personal-quota-label").textContent = `今天已使用 ${quota.usedMessages} 条`;
    personalBar.style.width = "100%";
    personalBar.classList.add("unlimited");
  } else {
    const percent = Math.min(100, quota.usedMessages / quota.messageLimit * 100);
    $("#ai-personal-quota-label").textContent = `${quota.usedMessages} / ${quota.messageLimit} 条`;
    personalBar.style.width = `${percent}%`;
    personalBar.classList.remove("unlimited");
  }
  if (state.account?.role === "admin") {
    $("#ai-global-quota").hidden = false;
    const globalPercent = Math.min(100, quota.globalEstimatedNeurons / quota.globalSoftLimitNeurons * 100);
    $("#ai-global-quota-label").textContent = `${quota.globalEstimatedNeurons.toFixed(0)} / ${quota.globalSoftLimitNeurons} N`;
    $("#ai-global-quota-bar").style.width = `${globalPercent}%`;
  }
}

function animateLatestAssistant(chat) {
  const paragraph = [...chat.querySelectorAll(".ai-bubble.assistant")].at(-1)?.querySelector("p");
  if (!paragraph) return;
  const content = paragraph.textContent;
  paragraph.textContent = "";
  paragraph.classList.add("typing-text");
  let index = 0;
  const tick = () => {
    index = Math.min(content.length, index + Math.max(1, Math.ceil(content.length / 90)));
    paragraph.textContent = content.slice(0, index);
    chat.scrollTop = chat.scrollHeight;
    if (index < content.length) requestAnimationFrame(tick);
    else paragraph.classList.remove("typing-text");
  };
  requestAnimationFrame(tick);
}

function showAiThinking(message) {
  const chat = $("#ai-chat");
  const user = document.createElement("div");
  user.className = "ai-bubble user";
  const name = document.createElement("strong");
  name.textContent = "你";
  const text = document.createElement("p");
  text.textContent = message || "（附件）";
  user.append(name, text);
  const thinking = document.createElement("div");
  thinking.className = "ai-bubble assistant ai-thinking";
  thinking.innerHTML = "<strong>日历搭子</strong><p><i></i><i></i><i></i><span>思考中</span></p>";
  chat.append(user, thinking);
  chat.scrollTop = chat.scrollHeight;
  return thinking;
}

function startAiProgress(thinking) {
  clearInterval(state.aiProgressTimer);
  const started = Date.now();
  state.aiProgressTimer = setInterval(async () => {
    const elapsed = Math.floor((Date.now() - started) / 1000);
    try {
      const conversation = await api("/api/ai/conversation");
      const phase = conversation.activeTurn?.phase || "正在等待模型返回";
      const label = thinking?.querySelector("span");
      if (label) label.textContent = `${phase} · ${elapsed} 秒`;
    } catch { /* Main request reports the final error. */ }
  }, 1500);
}

function stopAiProgress() {
  clearInterval(state.aiProgressTimer);
  state.aiProgressTimer = null;
}

async function animateProtocolPreview(raw, thinking) {
  if (!raw || !thinking) return;
  thinking.classList.remove("ai-thinking");
  thinking.innerHTML = "<strong>正在生成规则</strong><pre class=\"ai-protocol-stream\"></pre>";
  const target = thinking.querySelector("pre");
  for (let index = 0; index < raw.length; index += Math.max(1, Math.ceil(raw.length / 100))) {
    target.textContent = raw.slice(0, index + Math.max(1, Math.ceil(raw.length / 100)));
    $("#ai-chat").scrollTop = $("#ai-chat").scrollHeight;
    await new Promise((resolve) => setTimeout(resolve, 12));
  }
  await new Promise((resolve) => setTimeout(resolve, 350));
}

function renderAiContext(context = {}) {
  $("#ai-college").value = context.college ?? "";
  $("#ai-context-state").textContent = context.ready ? "资料完整，可以使用 AI" : `还缺 ${context.missing?.length ?? 0} 项`;
  $("#ai-context-state").classList.toggle("ready", Boolean(context.ready));
  const fields = $("#ai-context-fields");
  const rows = [];
  for (const location of context.locations ?? []) rows.push({ kind: "location", key: location.name, label: `坐标 · ${location.name}`, value: location.description, placeholder: "这里通常发生什么签到或活动？" });
  const courseKeys = new Set();
  for (const [index, course] of (context.courses ?? []).entries()) {
    const existingKey = String(course.id ?? "").trim();
    let key = existingKey && !courseKeys.has(existingKey) ? existingKey : `legacy-course-${index + 1}`;
    let suffix = 2;
    while (courseKeys.has(key)) {
      key = `legacy-course-${index + 1}-${suffix}`;
      suffix += 1;
    }
    courseKeys.add(key);
    rows.push({ kind: "course", key, label: `课程 · ${course.name}`, value: course.description, placeholder: "课程昵称、常见叫法或其他提示" });
  }
  fields.replaceChildren(...rows.map((row) => {
    const label = document.createElement("label");
    label.textContent = row.label;
    const input = document.createElement("input");
    input.maxLength = 500;
    input.placeholder = row.placeholder;
    input.value = row.value ?? "";
    input.dataset.contextKind = row.kind;
    input.dataset.contextKey = row.key;
    label.append(input);
    return label;
  }));
}

function syncAiContextPreview(calendar) {
  if (!state.aiConversation?.context || !state.account) return;
  const username = state.account.login_name ?? state.account.display_name;
  const user = (calendar.users ?? []).find((item) => item.username === username);
  const old = state.aiConversation.context;
  const locationDescriptions = new Map((old.locations ?? []).map((item) => [item.name, item.description]));
  const courseDescriptions = new Map((old.courses ?? []).map((item) => [item.id, item.description]));
  renderAiContext({
    ...old,
    locations: (calendar.locations ?? []).map((item) => ({ name: item.name, description: locationDescriptions.get(item.name) ?? "" })),
    courses: (user?.courses ?? []).map((item) => ({ id: item.id, name: item.name, description: courseDescriptions.get(item.id) ?? "" })),
    ready: false,
    missing: [],
  });
  $("#ai-context-state").textContent = "日历有改动，保存后将同步";
}

function renderAiProposal(pending) {
  const card = document.createElement("section");
  card.className = "ai-proposal";
  const title = document.createElement("strong");
  title.textContent = "待确认的日历改动";
  const list = document.createElement("ul");
  for (const item of pending.summary ?? []) {
    const row = document.createElement("li");
    row.textContent = item;
    list.append(row);
  }
  const actions = document.createElement("div");
  actions.className = "ai-proposal-actions";
  const deploy = document.createElement("button");
  deploy.className = "button primary";
  deploy.textContent = "确认部署到日历";
  deploy.dataset.aiProposal = "deploy";
  deploy.dataset.proposalId = pending.id;
  const discard = document.createElement("button");
  discard.className = "button soft";
  discard.textContent = "放弃这版";
  discard.dataset.aiProposal = "discard";
  discard.dataset.proposalId = pending.id;
  actions.append(deploy, discard);
  card.append(title, list, actions);
  return card;
}

$("#admin-users").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-account-id]");
  if (!button) return;
  try {
    await loadAdminDetail(button.dataset.accountId);
  } catch (error) { report(error.message, "error"); }
});

$("#admin-detail").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-admin-action]");
  if (!button) return;
  const accountId = button.dataset.accountId;
  const action = button.dataset.adminAction;
  try {
    if (action === "rotate-recovery") {
      const expected = button.dataset.loginName;
      const confirmation = prompt(`这会让旧恢复密钥失效，但不会修改密码或退出登录。请输入用户名 ${expected} 确认：`);
      if (confirmation === null) return;
      const result = await api(`/api/admin/users/${encodeURIComponent(accountId)}/recovery/rotate`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation }),
      });
      $("#admin-recovery-code").textContent = result.recoveryCode;
      await loadAdminUsers();
      report("新的恢复密钥已生成并显示，旧恢复密钥已失效。", "success", "恢复密钥已轮换");
      return;
    }
    if (action === "recovery") {
      if (!confirm("恢复密钥可以接管该账号。确认显示并记录本次查看吗？")) return;
      const result = await api(`/api/admin/users/${encodeURIComponent(accountId)}/recovery`, { method: "POST" });
      $("#admin-recovery-code").textContent = result.recoveryCode;
      report("恢复密钥已显示；本次查看已写入审计记录。", "success", "恢复密钥已解密");
      return;
    }
    if (action === "delete") {
      const expected = button.dataset.loginName;
      const confirmation = prompt(`删除后无法恢复。请输入用户名 ${expected} 确认：`);
      if (confirmation === null) return;
      await api(`/api/admin/users/${encodeURIComponent(accountId)}`, {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation }),
      });
      $("#admin-detail").innerHTML = "<p>该用户已删除。</p>";
      await loadAdminUsers();
      report(`用户 ${expected} 已删除。`, "success", "删除完成");
      return;
    }
    const status = action === "suspend" ? "suspended" : "active";
    await api(`/api/admin/users/${encodeURIComponent(accountId)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    await Promise.all([loadAdminUsers(), loadAdminDetail(accountId)]);
    report(status === "suspended" ? "用户已封禁，现有登录会话已退出。" : "用户已解除封禁。", "success");
  } catch (error) { report(error.message, "error"); }
});

let feedbackImageData = [];
let feedbackImagesBusy = false;

function renderFeedbackImagePreview() {
  $("#feedback-image-preview").replaceChildren(...feedbackImageData.map((src, index) => {
    const figure = document.createElement("figure");
    const img = document.createElement("img");
    img.src = src;
    img.alt = `待提交截图 ${index + 1}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "移除";
    remove.addEventListener("click", () => { feedbackImageData.splice(index, 1); renderFeedbackImagePreview(); });
    figure.append(img, remove);
    return figure;
  }));
}

async function addFeedbackImages(files) {
  if (feedbackImagesBusy) return;
  feedbackImagesBusy = true;
  try {
    for (const file of files) {
      if (feedbackImageData.length >= 3) throw new Error("最多添加 3 张截图");
      if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 15 * 1024 * 1024) throw new Error("请选择 15MB 以内的 PNG、JPEG 或 WebP 图片");
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      let src;
      for (const quality of [0.85, 0.7, 0.5, 0.3]) {
        src = canvas.toDataURL("image/jpeg", quality);
        if (src.length <= 280000) break;
      }
      if (src.length > 280000) throw new Error("截图内容过大，请裁剪后再上传");
      feedbackImageData.push(src);
      renderFeedbackImagePreview();
    }
  } catch (error) { report(error.message, "error", "截图添加失败"); }
  finally { feedbackImagesBusy = false; $("#feedback-images").value = ""; }
}

$("#feedback-images").addEventListener("change", (event) => addFeedbackImages([...event.target.files]));
$("#feedback-content").addEventListener("paste", (event) => {
  const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));
  if (files.length) { event.preventDefault(); addFeedbackImages(files); }
});

$("#feedback-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (feedbackImagesBusy) { report("图片处理中，请稍候再提交。", "error"); return; }
  const form = event.currentTarget;
  const button = event.submitter;
  button.disabled = true;
  try {
    await api("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        category: $("#feedback-category").value,
        subject: $("#feedback-subject").value,
        content: $("#feedback-content").value,
        images: feedbackImageData,
      }),
    });
    form.reset();
    feedbackImageData = [];
    renderFeedbackImagePreview();
    await loadMyFeedback();
    report("反馈已提交，管理员会在后台看到你的说明。", "success", "反馈已收到");
  } catch (error) { report(error.message, "error", "反馈提交失败"); }
  finally { button.disabled = false; }
});

async function saveDocument(kind, document, revision) {
  return api(`/api/documents/${kind}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ document, revision }),
  });
}

async function persistCalendar() {
  const document = state.calendarEditor.getDocument();
  const result = await saveDocument("calendar", document, state.calendarRevision);
  state.calendarRevision = result.revision;
  state.calendarEditor.setDocument(
    result.document,
    state.account?.login_name ?? state.account?.display_name ?? "当前用户",
    state.settingsDocument.classes ?? [],
  );
  $("#calendar-json").value = JSON.stringify(result.document, null, 2);
  $("#calendar-revision").textContent = "日历已同步";
  $("#calendar-dirty").textContent = "所有改动都已保存";
  $("#calendar-dirty").classList.remove("dirty");
  state.calendarDirty = false;
  await refreshAiConversation();
  broadcastUpdate("calendar");
  return result;
}

async function pollLogin(attemptId) {
  const result = await api(`/api/login/poll?id=${encodeURIComponent(attemptId)}`);
  if (result.status === "complete") {
    clearTimeout(state.loginTimer);
    state.loginAttempt = null;
    $("#qr-title").textContent = "Cookie 已安全收好";
    $("#qr-detail").textContent = "这串猫踩键盘一样的文字已经加密，页面不会把它展示出来。";
    renderCookieState(true);
    await loadData();
    report(
      result.classIds?.length
        ? `扫码成功，已自动识别班级：${result.classIds.join("、")}`
        : "扫码成功，Cookie 已保存；暂未在学生主页找到班级入口。",
      "success",
    );
  } else if (["failed", "expired"].includes(result.status)) {
    clearTimeout(state.loginTimer);
    state.loginAttempt = null;
    renderCookieState(state.cookieStored);
    throw new Error(result.error ?? "登录会话已结束，请重新生成二维码");
  }
  return result;
}

async function continueLoginPolling(attemptId) {
  if (state.loginAttempt !== attemptId) return;
  try {
    const result = await pollLogin(attemptId);
    if (result.status === "pending" && state.loginAttempt === attemptId) {
      if (result.confirmationReceived) {
        $("#qr-detail").textContent = "手机已确认，正在收取 Cookie……";
      }
      state.loginTimer = setTimeout(() => continueLoginPolling(attemptId), 1000);
    }
  } catch (error) {
    report(error.message, "error");
    if (state.loginAttempt === attemptId) {
      state.loginTimer = setTimeout(() => continueLoginPolling(attemptId), 1500);
    }
  }
}

document.querySelectorAll(".step").forEach((button) => button.addEventListener("click", () => switchPanel(button.dataset.panel)));

$("#add-window").addEventListener("click", () => {
  const windows = [...document.querySelectorAll(".polling-window-row")].map((row) => ({
    start: row.querySelector("[data-window-start]").value,
    end: row.querySelector("[data-window-end]").value,
  }));
  windows.push({ start: "08:00", end: "10:00" });
  renderPollingWindows(windows);
});

$("#polling-window-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-window]");
  if (!button) return;
  const windows = [...document.querySelectorAll(".polling-window-row")].map((row) => ({
    start: row.querySelector("[data-window-start]").value,
    end: row.querySelector("[data-window-end]").value,
  }));
  windows.splice(Number(button.dataset.removeWindow), 1);
  renderPollingWindows(windows);
});

$("#manage-locations").addEventListener("click", () => state.calendarEditor.openLocations());

async function saveCurrentSettings() {
  const result = await saveDocument("settings", settingsFromForm(), state.settingsRevision);
    state.settingsRevision = result.revision;
    state.settingsDocument = result.document;
    renderLocationOptions(state.calendarEditor.getDocument(), result.document.polling?.locationGroup);
    $("#settings-revision").textContent = "配置已同步";
    if (state.calendarDirty) await persistCalendar();
    else await refreshAiConversation();
    broadcastUpdate("settings");
  return result;
}

$("#save-settings").addEventListener("click", async () => {
  try {
    await saveCurrentSettings();
    report("轮询设置和坐标组已保存。云端这次真的记住了。", "success", "配置保存成功");
  } catch (error) { report(error.message, "error", "配置保存失败"); }
});

$("#start-attendance").addEventListener("click", async () => {
  const button = $("#start-attendance");
  button.disabled = true;
  try {
    if (state.attendanceRunning) {
      state.attendanceRunning = false;
      await saveCurrentSettings();
      renderAttendanceControl();
      report("签到已停止，定时轮询不会继续提交签到。", "success", "签到已停止");
      return;
    }
    if (!state.cookieStored) throw new Error("尚未保存 Cookie，请先扫码登录");
    if (!state.settingsDocument.classes?.length) throw new Error("尚未识别班级，请先完成扫码登录");
    if (!$("#default-location").value) throw new Error("请先选择默认轮询坐标组");
    state.attendanceRunning = true;
    await saveCurrentSettings();
    renderAttendanceControl();
    const result = await api("/api/attendance/run", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    const message = result.outcome === "no_task"
      ? "签到已启动。检查完成：当前没有签到任务。"
      : `签到已启动，本次处理结果：${result.outcome}，共 ${result.results.length} 个任务。`;
    report(message, result.outcome === "failure" ? "error" : "success", "签到启动结果");
    renderAttendanceLogs((await api("/api/attendance/logs")).logs);
  } catch (error) {
    state.attendanceRunning = Boolean(state.settingsDocument.enabled && state.settingsDocument.attendanceEnabled);
    renderAttendanceControl();
    report(`签到未能正常启动：${error.message}`, "error", "启动签到失败");
  } finally { button.disabled = false; }
});

$("#save-calendar").addEventListener("click", async () => {
  try {
    await persistCalendar();
    report("日历已保存，课表暂时没有反抗。", "success", "日历保存成功");
  } catch (error) { report(`日历没有保存：${error.message}`, "error"); }
});

$("#apply-calendar-json").addEventListener("click", () => {
  try {
    const document = JSON.parse($("#calendar-json").value);
    state.calendarEditor.setDocument(
      document,
      state.account?.login_name ?? state.account?.display_name ?? "当前用户",
      state.settingsDocument.classes ?? [],
    );
    $("#calendar-dirty").textContent = "JSON 已应用，记得保存";
    $("#calendar-dirty").classList.add("dirty");
    report("JSON 已放进可视化日历，确认无误后点击保存。", "success");
  } catch (error) {
    report(`JSON 无法应用：${error.message}`, "error");
  }
});

$("#save-pushplus").addEventListener("click", async () => {
  try {
    const value = $("#pushplus").value.trim();
    if (!value) throw new Error("请先填写 Token");
    const result = await api("/api/credentials", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "pushplus_token", value }),
    });
    $("#pushplus").value = "";
    renderPushplusState(result.pushplus.stored);
    report("个人 PushPlus Token 已加密保存。", "success");
  } catch (error) { report(error.message, "error"); }
});

$("#switch-pushplus").addEventListener("click", () => renderPushplusState(true, true));

$("#test-pushplus").addEventListener("click", async () => {
  const button = $("#test-pushplus");
  button.disabled = true;
  try {
    await api("/api/pushplus/test", { method: "POST" });
    report("测试消息已发送，请在微信中查看。此次测试不会写入签到日志。", "success", "PushPlus 测试成功");
  } catch (error) { report(error.message, "error", "PushPlus 测试失败"); }
  finally { button.disabled = false; }
});

$("#start-login").addEventListener("click", async () => {
  const button = $("#start-login");
  button.disabled = true;
  try {
    const result = await api("/api/login/start", { method: "POST" });
    $("#qr-stage").hidden = false;
    $("#qr-preview").src = result.preview;
    $("#qr-title").textContent = "请使用手机扫码";
    $("#qr-detail").textContent = "同意登录后，通常几秒内就能收好 Cookie。";
    button.textContent = "重新生成二维码";
    clearTimeout(state.loginTimer);
    state.loginAttempt = result.attemptId;
    state.loginTimer = setTimeout(() => continueLoginPolling(result.attemptId), 500);
    report("二维码已生成，轮到手机出场。", "success");
  } catch (error) {
    renderCookieState(state.cookieStored);
    report(error.message, "error");
  }
  finally { button.disabled = false; }
});

$("#run-check").addEventListener("click", async () => {
  try {
    if (!state.settingsDocument.classes?.length) throw new Error("尚未识别班级，请先完成扫码登录");
    const result = await api("/api/attendance/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    const message = result.writeBlocked
      ? `发现 ${result.taskIds.length} 个任务，但“允许实际签到”未开启，因此没有提交。`
      : result.outcome === "no_task"
        ? "检查完成：当前没有签到任务。"
        : `本次检查完成：${result.outcome}，处理 ${result.results.length} 个任务。`;
    report(message, result.outcome === "failure" ? "error" : "success", "签到检查结果");
    renderAttendanceLogs((await api("/api/attendance/logs")).logs);
  } catch (error) { report(error.message, "error", "签到检查失败"); }
});

function addAiFiles(files) {
  const accepted = [...files].filter((file) => file.type.startsWith("image/") || /\.(txt|csv|json|ics)$/i.test(file.name));
  for (const file of accepted) {
    const duplicate = state.aiFiles.some((item) => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified);
    if (!duplicate && state.aiFiles.length < 4) state.aiFiles.push(file);
  }
  renderAiFiles();
}

function renderAiFiles() {
  const list = $("#ai-file-list");
  list.replaceChildren(...state.aiFiles.map((file, index) => {
    const item = document.createElement("div");
    item.className = "ai-file-item";
    if (file.type.startsWith("image/")) {
      const preview = document.createElement("img");
      preview.src = URL.createObjectURL(file);
      preview.alt = "";
      preview.onload = () => URL.revokeObjectURL(preview.src);
      item.append(preview);
    } else {
      const icon = document.createElement("b");
      icon.textContent = "TXT";
      item.append(icon);
    }
    const copy = document.createElement("span");
    copy.textContent = `${file.name} · ${(file.size / 1024).toFixed(0)} KB`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.dataset.removeAiFile = String(index);
    remove.setAttribute("aria-label", `删除 ${file.name}`);
    remove.textContent = "删除";
    item.append(copy, remove);
    return item;
  }));
  $("#clear-ai-files").hidden = state.aiFiles.length === 0;
  $("#ai-file-state").textContent = state.aiFiles.length ? `已添加 ${state.aiFiles.length} 个附件` : "尚未添加附件";
}

$("#ai-files").addEventListener("change", (event) => {
  addAiFiles(event.target.files);
  event.target.value = "";
});

$("#ai-file-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-ai-file]");
  if (!button) return;
  state.aiFiles.splice(Number(button.dataset.removeAiFile), 1);
  renderAiFiles();
});

$("#clear-ai-files").addEventListener("click", () => {
  state.aiFiles = [];
  renderAiFiles();
});

for (const eventName of ["dragenter", "dragover"]) {
  $("#ai-drop-zone").addEventListener(eventName, (event) => {
    event.preventDefault();
    $("#ai-drop-zone").classList.add("dragging");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  $("#ai-drop-zone").addEventListener(eventName, (event) => {
    event.preventDefault();
    $("#ai-drop-zone").classList.remove("dragging");
    if (eventName === "drop") addAiFiles(event.dataTransfer.files);
  });
}

$("#ai-message").addEventListener("paste", (event) => {
  const images = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));
  if (images.length) {
    event.preventDefault();
    addAiFiles(images);
  }
});

function applyAiDeployment(result) {
  if (!result.deployed || !result.document) return;
  state.calendarRevision = result.revision;
  state.calendarEditor.setDocument(
    result.document,
    state.account?.login_name ?? state.account?.display_name ?? "当前用户",
    state.settingsDocument.classes ?? [],
  );
  $("#calendar-json").value = JSON.stringify(result.document, null, 2);
  $("#calendar-revision").textContent = "日历已同步";
  $("#calendar-dirty").textContent = "AI 改动已部署";
  $("#calendar-dirty").classList.remove("dirty");
  state.calendarDirty = false;
}

$("#ai-chat").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-ai-proposal]");
  if (!button) return;
  button.disabled = true;
  try {
    if (button.dataset.aiProposal === "deploy") {
      const result = await api("/api/ai/calendar/deploy", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proposalId: button.dataset.proposalId }),
      });
      applyAiDeployment(result);
      await refreshAiConversation();
      broadcastUpdate("ai-calendar");
      switchPanel("calendar");
      report(result.reply, "success", "日历部署完成");
    } else {
      await api("/api/ai/calendar/discard", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proposalId: button.dataset.proposalId }),
      });
      renderAiConversation(await api("/api/ai/conversation"));
      report("这版改动已放弃，日历没有变化。", "success", "方案已放弃");
    }
  } catch (error) {
    report(error.message, "error", "日历方案处理失败");
  } finally { button.disabled = false; }
});

async function extractAiAttachments() {
  if (!state.aiFiles.length) return "";
  const parts = [];
  let total = 0;
  for (const file of state.aiFiles) {
    if (file.type.startsWith("image/")) continue;
    if (!/\.(txt|csv|json|ics)$/i.test(file.name)) {
      throw new Error(`${file.name} 暂未支持解析；当前可测试 TXT、CSV、JSON 和 ICS`);
    }
    if (file.size > 1024 * 1024) throw new Error(`${file.name} 超过 1MB`);
    const text = await file.text();
    total += text.length;
    if (total > 30_000) throw new Error("附件提取文本合计不能超过 30000 个字符");
    parts.push(`--- ${file.name} ---\n${text}`);
  }
  return parts.join("\n\n");
}

async function imagePayload(file) {
  if (file.size > 8 * 1024 * 1024) throw new Error(`${file.name} 超过 8MB，请先压缩`);
  const bitmap = await createImageBitmap(file);
  // Keep long screenshots wide enough for Chinese OCR instead of shrinking by their tallest edge.
  const pixelScale = Math.sqrt(5_000_000 / Math.max(1, bitmap.width * bitmap.height));
  const scale = Math.min(1, 1800 / bitmap.width, 4000 / bitmap.height, pixelScale);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
  if (!blob) throw new Error(`${file.name} 无法读取`);
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`${file.name} 读取失败`));
    reader.readAsDataURL(blob);
  });
  return { name: file.name, type: "image/jpeg", data: String(dataUrl).split(",")[1] };
}

async function prepareAiImages() {
  const images = state.aiFiles.filter((file) => file.type.startsWith("image/"));
  if (images.length > 3) throw new Error("一次最多添加 3 张图片，请删除多余图片");
  return Promise.all(images.map(imagePayload));
}

$("#send-ai").addEventListener("click", async () => {
  const button = $("#send-ai");
  button.disabled = true;
  button.textContent = "思考中…";
  state.aiAbortController = new AbortController();
  $("#stop-ai").hidden = false;
  try {
    const [attachmentText, images] = await Promise.all([extractAiAttachments(), prepareAiImages()]);
    const message = $("#ai-message").value.trim();
    if (!message && !attachmentText) throw new Error("请输入消息或添加文本文件");
    const thinking = showAiThinking(message);
    startAiProgress(thinking);
    const result = await api("/api/ai/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, attachmentText, images }),
      signal: state.aiAbortController.signal,
    });
    stopAiProgress();
    await animateProtocolPreview(result.protocolPreview, thinking);
    applyAiDeployment(result);
    $("#ai-message").value = "";
    $("#ai-files").value = "";
    state.aiFiles = [];
    renderAiFiles();
    await refreshAiConversation({ animateLatest: true });
    if (result.deployed || result.proposal) broadcastUpdate("ai-calendar");
    notice(result.failed ? "AI 本轮处理失败，原因已保留在对话中。" : result.deployed ? "AI 已确认部署，日历已经更新。" : "AI 已回复；待确认改动会显示为清单。", result.failed ? "error" : "success");
  } catch (error) {
    refreshAiConversation().catch(() => {});
    if (error.name === "AbortError") notice("已终止当前 AI 请求。", "success");
    else report(error.message, "error", "AI 请求失败");
  }
  finally { stopAiProgress(); state.aiAbortController = null; $("#stop-ai").hidden = true; button.disabled = false; button.textContent = "发送"; }
});

$("#stop-ai").addEventListener("click", async () => {
  state.aiAbortController?.abort();
  stopAiProgress();
  try {
    await api("/api/ai/chat/stop", { method: "POST" });
    await refreshAiConversation();
    notice("已终止本次思考，提问和终止说明均已保留。", "success");
  } catch (error) { notice(error.message, "error"); }
});

$("#agree-vision-license").addEventListener("click", async () => {
  const button = $("#agree-vision-license");
  button.disabled = true;
  button.textContent = "正在启用…";
  try {
    await api("/api/ai/vision/agree", { method: "POST" });
    button.textContent = "图片识别已启用";
    $(".vision-license").hidden = true;
    report("Meta 图片模型许可已接受，课表截图现在可以交给 AI 识别。", "success", "图片识别已启用");
  } catch (error) {
    button.textContent = "我已阅读并同意，启用图片识别";
    button.disabled = false;
    report(error.message, "error", "图片识别未启用");
  }
});

$("#save-ai-context").addEventListener("click", async () => {
  const button = $("#save-ai-context");
  button.disabled = true;
  try {
    const context = { college: $("#ai-college").value.trim(), locations: {}, courses: {} };
    document.querySelectorAll("[data-context-kind]").forEach((input) => {
      const bucket = input.dataset.contextKind === "location" ? context.locations : context.courses;
      bucket[input.dataset.contextKey] = input.value.trim();
    });
    await api("/api/ai/context", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context }),
    });
    renderAiConversation(await api("/api/ai/conversation"));
    report("学院、坐标和课程说明已写入用户.md。", "success", "AI 基础资料已保存");
  } catch (error) { report(error.message, "error", "基础资料未保存"); }
  finally { button.disabled = false; }
});

$("#reset-ai-context").addEventListener("click", async () => {
  if (!confirm("将清空学院、坐标和课程说明；其他用户.md 记忆不会删除。确定继续吗？")) return;
  try {
    await api("/api/ai/context/reset", { method: "POST" });
    renderAiConversation(await api("/api/ai/conversation"));
    report("基础资料已清空，请按需要重新填写。", "success", "基础资料已重置");
  } catch (error) { report(error.message, "error", "基础资料重置失败"); }
});

$("#ai-diagnostic-consent").addEventListener("change", async (event) => {
  const input = event.currentTarget;
  input.disabled = true;
  try {
    await api("/api/ai/diagnostic-consent", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: input.checked }),
    });
    report(input.checked ? "已允许管理员在必要排障时查看最近 10 条文字对话。" : "已关闭管理员对话诊断授权。", "success");
  } catch (error) {
    input.checked = !input.checked;
    report(error.message, "error", "设置未保存");
  } finally { input.disabled = false; }
});

$("#probe-ai").addEventListener("click", async () => {
  const button = $("#probe-ai");
  button.disabled = true;
  try {
    const result = await api("/api/ai/probe", { method: "POST" });
    report(`Workers AI 已连通，模型返回：${result.response || "（空响应）"}`, "success", "AI API 测试完成");
  } catch (error) { report(error.message, "error", "AI API 测试失败"); }
  finally { button.disabled = false; }
});

$("#ai-message").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    $("#send-ai").click();
  }
});

const infoPopover = document.createElement("aside");
infoPopover.className = "global-info-popover";
infoPopover.hidden = true;
document.body.append(infoPopover);
let activeInfoTip = null;

function hideInfoTip() {
  infoPopover.hidden = true;
  activeInfoTip = null;
}

function showInfoTip(tip) {
  const content = tip.querySelector(":scope > span");
  if (!content) return;
  activeInfoTip = tip;
  infoPopover.innerHTML = content.innerHTML;
  infoPopover.hidden = false;
  const rect = tip.getBoundingClientRect();
  const width = Math.min(360, window.innerWidth - 24);
  infoPopover.style.width = `${width}px`;
  const height = infoPopover.offsetHeight;
  const left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.left + rect.width / 2 - width / 2));
  const below = rect.bottom + 10;
  const top = below + height <= window.innerHeight - 10 ? below : Math.max(10, rect.top - height - 10);
  infoPopover.style.left = `${left}px`;
  infoPopover.style.top = `${top}px`;
}

document.addEventListener("click", (event) => {
  const tip = event.target.closest(".info-tip");
  if (tip) {
    event.preventDefault();
    event.stopPropagation();
    showInfoTip(tip);
  } else if (!event.target.closest(".global-info-popover")) hideInfoTip();
});
document.addEventListener("mouseover", (event) => {
  const tip = event.target.closest(".info-tip");
  if (tip && matchMedia("(hover: hover)").matches) showInfoTip(tip);
});
document.addEventListener("focusin", (event) => {
  const tip = event.target.closest(".info-tip");
  if (tip) showInfoTip(tip);
});
window.addEventListener("resize", hideInfoTip);

syncChannel?.addEventListener("message", () => {
  if (!state.account) return;
  if (!state.calendarDirty && document.visibilityState === "visible") loadData().catch(() => {});
  else scheduleAiRefresh();
});

$("#save-ai-memory").addEventListener("click", async () => {
  try {
    await api("/api/ai/memory", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: $("#ai-memory").value }),
    });
    report("用户.md 已保存，后续对话会带上这些长期信息。", "success");
  } catch (error) { report(error.message, "error", "用户.md 保存失败"); }
});

$("#clear-ai-context").addEventListener("click", async () => {
  if (!confirm("清除当前对话和自动摘要？你手动保存的用户.md与基础资料会保留。")) return;
  try {
    await api("/api/ai/conversation", { method: "DELETE" });
    renderAiConversation(await api("/api/ai/conversation"));
    report("对话上下文与自动摘要已清除，用户.md和基础资料保持不变。", "success");
  } catch (error) { report(error.message, "error", "清理失败"); }
});

(async () => {
  try {
    const session = await api("/api/auth/session");
    if (session.authenticated) await enterApp();
    else authMessage("还没登录。新同学可以直接注册，不需要银行卡。 ");
  } catch (error) {
    authMessage(`暂时进不去：${error.message}`, true);
  }
})();
