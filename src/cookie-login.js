import QRCode from "qrcode";
import { calendarToRules } from "./calendar-rules.js";
import { fetchK8n } from "./k8n-gateway.js";
import { decryptSecret, encryptSecret, loadSecret, saveSecret } from "./secure-data.js";

const QR_PAGE_URL = "https://k8n.cn/login/qr/weixin/student/2";
const REMEMBER_COOKIE = "remember_student_59ba36addc2b2f9401580f014c7f58ea4e30989d";
const LOGIN_TTL_SECONDS = 2 * 60;
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 " +
  "Chrome/119.0.0.0 Safari/537.36";

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isoAfter(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function setCookieValues(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const value = headers.get("set-cookie");
  return value ? [value] : [];
}

function collectResponseCookies(response, jar) {
  for (const value of setCookieValues(response.headers)) {
    const match = /^\s*([^=;\s]+)=([^;]*)/.exec(value);
    if (match) jar.set(match[1], match[2]);
  }
}

function cookieHeader(jar) {
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

function validateK8nUrl(value, base = QR_PAGE_URL) {
  const url = new URL(value, base);
  if (url.hostname !== "k8n.cn") throw new Error("Unexpected login destination");
  url.protocol = "https:";
  return url;
}

async function k8nFetch(env, url, jar = new Map(), options = {}) {
  const headers = {
    Accept: options.json
      ? "application/json, text/javascript, */*; q=0.01"
      : "text/html,application/json;q=0.9,*/*;q=0.8",
    "Cache-Control": "no-cache",
    "User-Agent": USER_AGENT,
  };
  if (options.json) {
    headers.Referer = QR_PAGE_URL;
    headers["X-Requested-With"] = "XMLHttpRequest";
  }
  if (jar.size) headers.Cookie = cookieHeader(jar);
  const response = await fetchK8n(env, url, {
    headers,
    redirect: "manual",
    timeoutMs: options.timeoutMs ?? 10_000,
  });
  collectResponseCookies(response, jar);
  return response;
}

function qrTargetFromHtml(html) {
  const match = /var\s+qrurl\s*=\s*("(?:[^"\\]|\\.)*")/.exec(html);
  if (!match) throw new Error("QR target was not found");
  return validateK8nUrl(JSON.parse(match[1]));
}

function rememberedCookie(jar) {
  const value = jar.get(REMEMBER_COOKIE);
  return value ? `${REMEMBER_COOKIE}=${value}` : null;
}

async function followLoginDestination(env, destination, jar) {
  let current = validateK8nUrl(destination);
  for (let hop = 0; hop < 8; hop += 1) {
    const response = await k8nFetch(env, current, jar);
    const cookie = rememberedCookie(jar);
    if (cookie) return { cookie, redirectedToStudent: current.pathname.startsWith("/student") };
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get("location");
    if (!location) break;
    current = validateK8nUrl(location, current);
  }
  return { cookie: null, redirectedToStudent: current.pathname.startsWith("/student") };
}

async function createQrSession(env) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const jar = new Map();
    try {
      const response = await k8nFetch(env, QR_PAGE_URL, jar, { timeoutMs: 6_000 });
      if (!response.ok) throw new Error(`QR page returned HTTP ${response.status}`);
      const target = qrTargetFromHtml(await response.text());
      const sessionCookie = jar.get("s");
      if (!sessionCookie) throw new Error("QR session cookie was not issued");
      return { target, sessionCookie };
    } catch (error) {
      lastError = error;
      if (attempt < 2) await delay(250 * (attempt + 1));
    }
  }
  throw lastError ?? new Error("Unable to create QR session");
}

async function discoverClassIds(env, jar) {
  try {
    let current = new URL("https://k8n.cn/student");
    for (let hop = 0; hop < 4; hop += 1) {
      const response = await k8nFetch(env, current, jar, { timeoutMs: 6_000 });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) return [];
        current = validateK8nUrl(location, current);
        continue;
      }
      if (!response.ok) return [];
      const html = await response.text();
      return [...new Set(
        [...html.matchAll(/(?:https?:\/\/k8n\.cn)?\/student\/course\/(\d+)/g)]
          .map((match) => match[1]),
      )];
    }
    return [];
  } catch {
    return [];
  }
}

async function saveDetectedClasses(env, accountId, classIds) {
  if (!classIds.length) return;
  const credential = await env.DB.prepare(
    "SELECT login_name FROM auth_credentials WHERE account_id = ?",
  ).bind(accountId).first();
  if (!credential?.login_name) return;

  const settingsRow = await env.DB.prepare(
    "SELECT document_json, revision FROM user_documents WHERE account_id = ?",
  ).bind(accountId).first();
  const settings = settingsRow ? JSON.parse(settingsRow.document_json) : {};
  settings.username = credential.login_name;
  settings.classes = classIds;
  const nextSettingsRevision = Number(settingsRow?.revision ?? 0) + 1;

  const calendarRow = await env.DB.prepare(
    "SELECT document_json, revision FROM calendar_documents WHERE account_id = ?",
  ).bind(accountId).first();
  const calendar = calendarRow
    ? JSON.parse(calendarRow.document_json)
    : { version: 1, locations: [], users: [] };
  calendar.users ??= [];
  let calendarUser = calendar.users.find((user) => user.username === credential.login_name);
  if (!calendarUser) {
    calendarUser = {
      username: credential.login_name,
      classes: [],
      window_minutes: 20,
      courses: [],
      single_tasks: [],
      repeat_tasks: [],
    };
    calendar.users.push(calendarUser);
  }
  calendarUser.classes = classIds;
  const nextCalendarRevision = Number(calendarRow?.revision ?? 0) + 1;

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO user_documents (account_id, document_json, revision, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(account_id) DO UPDATE SET document_json = excluded.document_json,
         revision = excluded.revision, updated_at = CURRENT_TIMESTAMP`,
    ).bind(accountId, JSON.stringify(settings), nextSettingsRevision),
    env.DB.prepare(
      `INSERT INTO calendar_documents (account_id, document_json, revision, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(account_id) DO UPDATE SET document_json = excluded.document_json,
         revision = excluded.revision, updated_at = CURRENT_TIMESTAMP`,
    ).bind(accountId, JSON.stringify(calendar), nextCalendarRevision),
    env.DB.prepare(
      `INSERT INTO calendar_rule_documents (account_id,rules_text,updated_at)
       VALUES (?,?,CURRENT_TIMESTAMP) ON CONFLICT(account_id) DO UPDATE SET
       rules_text=excluded.rules_text, updated_at=CURRENT_TIMESTAMP`,
    ).bind(accountId, calendarToRules(calendar, credential.login_name)),
  ]);
}

export async function refreshDetectedClasses(env, accountId) {
  const cookie = await loadSecret(env, accountId, "bjmf_cookie");
  if (!cookie) throw new Error("尚未保存 Cookie，请先扫码登录");
  const separator = cookie.indexOf("=");
  if (separator < 1) throw new Error("Cookie 格式无效，请重新扫码登录");
  const classIds = await discoverClassIds(env, new Map([[cookie.slice(0, separator), cookie.slice(separator + 1)]]));
  if (!classIds.length) throw new Error("暂未在班级魔方学生主页找到班级，请稍后重试或重新扫码登录");
  await saveDetectedClasses(env, accountId, classIds);
  return { classIds };
}

export async function startCookieLogin(env, accountId) {
  const { target, sessionCookie } = await createQrSession(env);

  const attemptId = crypto.randomUUID();
  const encrypted = await encryptSecret(
    env,
    accountId,
    `qr-session:${attemptId}`,
    sessionCookie,
  );
  const svg = await QRCode.toString(target.toString(), {
    type: "svg",
    width: 320,
    margin: 2,
    errorCorrectionLevel: "M",
    color: { dark: "#132238", light: "#ffffff" },
  });
  const preview = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE login_attempts SET status = 'cancelled', session_ciphertext = NULL,
        session_iv = NULL WHERE account_id = ? AND status = 'pending'`,
    ).bind(accountId),
    env.DB.prepare(
      `INSERT INTO login_attempts
      (id, account_id, browser_session_id, status, expires_at, transport,
       session_ciphertext, session_iv)
     VALUES (?, ?, 'direct-http', 'pending', ?, 'direct-http', ?, ?)`,
    ).bind(
      attemptId,
      accountId,
      isoAfter(LOGIN_TTL_SECONDS),
      encrypted.ciphertext,
      encrypted.iv,
    ),
  ]);

  return { attemptId, status: "pending", preview, expiresInSeconds: LOGIN_TTL_SECONDS };
}

export async function pollCookieLogin(env, accountId, attemptId) {
  const attempt = await env.DB.prepare(
    `SELECT id, status, expires_at, transport, session_ciphertext, session_iv
       FROM login_attempts WHERE id = ? AND account_id = ?`,
  ).bind(attemptId, accountId).first();
  if (!attempt) return { status: "not_found" };
  if (attempt.status !== "pending") return { status: attempt.status };
  if (Date.parse(attempt.expires_at) <= Date.now()) {
    await env.DB.prepare(
      `UPDATE login_attempts SET status = 'expired', session_ciphertext = NULL,
        session_iv = NULL WHERE id = ? AND account_id = ?`,
    ).bind(attemptId, accountId).run();
    return { status: "expired" };
  }
  if (attempt.transport !== "direct-http" || !attempt.session_ciphertext || !attempt.session_iv) {
    return { status: "failed", error: "Unsupported login session; please generate a new QR code" };
  }

  try {
    const sessionCookie = await decryptSecret(env, accountId, `qr-session:${attemptId}`, {
      ciphertext: attempt.session_ciphertext,
      iv: attempt.session_iv,
    });
    const jar = new Map([["s", sessionCookie]]);
    const checkUrl = new URL(QR_PAGE_URL);
    checkUrl.searchParams.set("op", "checklogin");
    const response = await k8nFetch(env, checkUrl, jar, { json: true, timeoutMs: 6_000 });
    if (!response.ok) throw new Error(`Login check returned HTTP ${response.status}`);
    const result = await response.json();

    await env.DB.prepare(
      "UPDATE login_attempts SET last_polled_at = CURRENT_TIMESTAMP WHERE id = ? AND account_id = ?",
    ).bind(attemptId, accountId).run();
    if (!result.status) return { status: "pending" };

    let cookie = rememberedCookie(jar);
    let redirectedToStudent = false;
    if (!cookie && result.url) {
      const completed = await followLoginDestination(env, result.url, jar);
      cookie = completed.cookie;
      redirectedToStudent = completed.redirectedToStudent;
    }
    if (!cookie) return { status: "pending", confirmationReceived: true };

    await saveSecret(env, accountId, "bjmf_cookie", cookie);
    const classIds = await discoverClassIds(env, jar);
    await saveDetectedClasses(env, accountId, classIds);
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE login_attempts SET status = 'complete', last_polled_at = CURRENT_TIMESTAMP,
          session_ciphertext = NULL, session_iv = NULL WHERE id = ? AND account_id = ?`,
      ).bind(attemptId, accountId),
      env.DB.prepare(
        `INSERT INTO audit_events (id, account_id, event_type, outcome)
         VALUES (?, ?, 'credential.cookie.store', 'success')`,
      ).bind(crypto.randomUUID(), accountId),
    ]);
    return { status: "complete", redirectedToStudent, classIds };
  } catch (error) {
    await env.DB.prepare(
      `UPDATE login_attempts SET last_polled_at = CURRENT_TIMESTAMP,
        error_category = 'direct_http' WHERE id = ? AND account_id = ?`,
    ).bind(attemptId, accountId).run();
    return {
      status: "pending",
      retryable: true,
      error: error instanceof Error ? error.message : "Login check failed",
    };
  }
}

export async function credentialStatus(env, accountId) {
  const rows = await env.DB.prepare(
    `SELECT secret_kind, updated_at FROM credential_secrets WHERE account_id = ?`,
  ).bind(accountId).all();
  const stored = Object.fromEntries(
    (rows.results ?? []).map((row) => [row.secret_kind, { stored: true, updatedAt: row.updated_at }]),
  );
  return {
    cookie: stored.bjmf_cookie ?? { stored: false, updatedAt: null },
    pushplus: stored.pushplus_token ?? { stored: false, updatedAt: null },
  };
}
