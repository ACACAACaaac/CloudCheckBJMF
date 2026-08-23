import { encryptSecret } from "./secure-data.js";

const SESSION_COOKIE = "autocheck_session";
const SESSION_SECONDS = 30 * 24 * 60 * 60;
// Cloudflare Workers caps one PBKDF2 operation at 100,000 iterations.
const PASSWORD_ITERATIONS = 100_000;

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomToken(byteLength = 32) {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function sha256(value) {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeLoginName(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.@-]{2,63}$/.test(normalized)) {
    throw new Error("用户名需为 3-64 位英文字母、数字或 . _ @ -");
  }
  return normalized;
}

function validatePassword(value) {
  const password = String(value ?? "");
  if (password.length < 8 || password.length > 128) {
    throw new Error("密码长度需为 8-128 位");
  }
  return password;
}

async function derivePassword(password, salt, iterations = PASSWORD_ITERATIONS) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    256,
  );
  return bytesToBase64Url(new Uint8Array(bits));
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function cookieValue(request, name) {
  const cookies = request.headers.get("cookie") ?? "";
  for (const part of cookies.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

function sessionCookie(token, maxAge = SESSION_SECONDS) {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

async function createSession(env, accountId) {
  const token = randomToken();
  const tokenHash = await sha256(token);
  const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO sessions (id_hash, account_id, expires_at)
     VALUES (?, ?, ?)`,
  ).bind(tokenHash, accountId, expiresAt).run();
  return { token, expiresAt };
}

async function rateLimitKey(request, env, action) {
  const address = request.headers.get("cf-connecting-ip") ?? "unknown";
  return sha256(`${env.RATE_LIMIT_PEPPER ?? "unconfigured"}:${action}:${address}`);
}

async function assertRateLimit(request, env, action, limit) {
  const key = await rateLimitKey(request, env, action);
  const row = await env.DB.prepare(
    `SELECT attempts, window_started_at, blocked_until FROM auth_rate_limits WHERE key_hash = ?`,
  ).bind(key).first();
  const now = Date.now();
  if (row?.blocked_until && Date.parse(row.blocked_until) > now) {
    throw new Error("尝试次数过多，请稍后再试");
  }
  const windowExpired = !row || now - Date.parse(row.window_started_at) > 60 * 60 * 1000;
  const attempts = windowExpired ? 1 : Number(row.attempts) + 1;
  const blockedUntil = attempts > limit ? new Date(now + 15 * 60 * 1000).toISOString() : null;
  await env.DB.prepare(
    `INSERT INTO auth_rate_limits
      (key_hash, attempts, window_started_at, blocked_until, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key_hash) DO UPDATE SET
       attempts = excluded.attempts,
       window_started_at = excluded.window_started_at,
       blocked_until = excluded.blocked_until,
       updated_at = CURRENT_TIMESTAMP`,
  ).bind(
    key,
    attempts,
    windowExpired ? new Date(now).toISOString() : row.window_started_at,
    blockedUntil,
  ).run();
  if (blockedUntil) throw new Error("尝试次数过多，请 15 分钟后再试");
}

async function clearRateLimit(request, env, action) {
  const key = await rateLimitKey(request, env, action);
  await env.DB.prepare("DELETE FROM auth_rate_limits WHERE key_hash = ?").bind(key).run();
}

function recoveryCode() {
  const raw = randomToken(18).toUpperCase();
  return raw.match(/.{1,6}/g).join("-");
}

export async function registerAccount(request, env, body) {
  await assertRateLimit(request, env, "register", 5);
  const loginName = normalizeLoginName(body.loginName);
  const password = validatePassword(body.password);
  const displayName = loginName;
  const existing = await env.DB.prepare(
    "SELECT account_id FROM auth_credentials WHERE login_name = ?",
  ).bind(loginName).first();
  if (existing) throw new Error("该用户名已被使用");

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const passwordHash = await derivePassword(password, salt);
  const accountId = crypto.randomUUID();
  const code = recoveryCode();
  const codeHash = await sha256(`${loginName}:${code}`);
  const encryptedRecovery = await encryptSecret(env, accountId, "recovery_code", code);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO accounts (id, display_name, status) VALUES (?, ?, 'active')",
    ).bind(accountId, displayName),
    env.DB.prepare(
      `INSERT INTO auth_credentials
        (account_id, login_name, password_hash, password_salt, password_iterations)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(accountId, loginName, passwordHash, bytesToBase64Url(salt), PASSWORD_ITERATIONS),
    env.DB.prepare(
      `INSERT INTO recovery_codes (account_id, code_hash, ciphertext, iv, key_version)
       VALUES (?, ?, ?, ?, 1)`,
    ).bind(accountId, codeHash, encryptedRecovery.ciphertext, encryptedRecovery.iv),
    env.DB.prepare(
      `INSERT INTO audit_events (id, account_id, event_type, outcome)
       VALUES (?, ?, 'account.register', 'success')`,
    ).bind(crypto.randomUUID(), accountId),
  ]);
  const session = await createSession(env, accountId);
  return {
    account: { id: accountId, display_name: displayName, status: "active", login_name: loginName, role: "user" },
    recoveryCode: code,
    cookie: sessionCookie(session.token),
  };
}

export async function loginAccount(request, env, body) {
  await assertRateLimit(request, env, "login", 10);
  const loginName = normalizeLoginName(body.loginName);
  const password = validatePassword(body.password);
  const row = await env.DB.prepare(
    `SELECT c.account_id, c.password_hash, c.password_salt, c.password_iterations,
            a.display_name, a.status, a.role
       FROM auth_credentials c JOIN accounts a ON a.id = c.account_id
      WHERE c.login_name = ?`,
  ).bind(loginName).first();
  if (!row || row.status !== "active") throw new Error("用户名或密码错误");
  const candidate = await derivePassword(
    password,
    base64UrlToBytes(row.password_salt),
    Number(row.password_iterations),
  );
  if (!constantTimeEqual(candidate, row.password_hash)) throw new Error("用户名或密码错误");
  await clearRateLimit(request, env, "login");
  const session = await createSession(env, row.account_id);
  return {
    account: {
      id: row.account_id,
      display_name: row.display_name,
      status: row.status,
      login_name: loginName,
      role: row.role,
    },
    cookie: sessionCookie(session.token),
  };
}

export async function accountFromSession(request, env) {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const account = await env.DB.prepare(
    `SELECT a.id, a.display_name, a.status, a.role, a.ai_reputation,
            a.status_reason, c.login_name
       FROM sessions s
       JOIN accounts a ON a.id = s.account_id
       JOIN auth_credentials c ON c.account_id = a.id
      WHERE s.id_hash = ? AND datetime(s.expires_at) > CURRENT_TIMESTAMP`,
  ).bind(tokenHash).first();
  if (!account || account.status !== "active") return null;
  await env.DB.prepare(
    "UPDATE sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE id_hash = ?",
  ).bind(tokenHash).run();
  return account;
}

export async function logoutAccount(request, env) {
  const token = cookieValue(request, SESSION_COOKIE);
  if (token) {
    await env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(await sha256(token)).run();
  }
  return sessionCookie("", 0);
}

export async function recoverAccount(request, env, body) {
  await assertRateLimit(request, env, "recover", 5);
  const loginName = normalizeLoginName(body.loginName);
  const password = validatePassword(body.newPassword);
  const code = String(body.recoveryCode ?? "").trim().toUpperCase();
  const row = await env.DB.prepare(
    `SELECT c.account_id, r.code_hash, r.used_at
       FROM auth_credentials c JOIN recovery_codes r ON r.account_id = c.account_id
      WHERE c.login_name = ?`,
  ).bind(loginName).first();
  if (!row || row.used_at || !constantTimeEqual(await sha256(`${loginName}:${code}`), row.code_hash)) {
    throw new Error("恢复信息无效");
  }

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const passwordHash = await derivePassword(password, salt);
  const nextCode = recoveryCode();
  const nextCodeHash = await sha256(`${loginName}:${nextCode}`);
  const encryptedRecovery = await encryptSecret(env, row.account_id, "recovery_code", nextCode);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE auth_credentials SET password_hash = ?, password_salt = ?,
        password_iterations = ?, updated_at = CURRENT_TIMESTAMP WHERE account_id = ?`,
    ).bind(passwordHash, bytesToBase64Url(salt), PASSWORD_ITERATIONS, row.account_id),
    env.DB.prepare(
      `UPDATE recovery_codes SET code_hash = ?, ciphertext = ?, iv = ?, key_version = 1,
        created_at = CURRENT_TIMESTAMP, used_at = NULL
        WHERE account_id = ?`,
    ).bind(nextCodeHash, encryptedRecovery.ciphertext, encryptedRecovery.iv, row.account_id),
    env.DB.prepare("DELETE FROM sessions WHERE account_id = ?").bind(row.account_id),
  ]);
  const session = await createSession(env, row.account_id);
  return { recoveryCode: nextCode, cookie: sessionCookie(session.token) };
}

export async function rotateRecoveryCodeForAdmin(env, adminId, accountId) {
  const target = await env.DB.prepare(
    `SELECT a.id, c.login_name FROM accounts a
       JOIN auth_credentials c ON c.account_id=a.id WHERE a.id=?`,
  ).bind(accountId).first();
  if (!target) throw new Error("User not found");
  const code = recoveryCode();
  const codeHash = await sha256(`${target.login_name}:${code}`);
  const encrypted = await encryptSecret(env, accountId, "recovery_code", code);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO recovery_codes (account_id,code_hash,ciphertext,iv,key_version,created_at,used_at)
       VALUES (?,?,?,?,1,CURRENT_TIMESTAMP,NULL)
       ON CONFLICT(account_id) DO UPDATE SET code_hash=excluded.code_hash,
         ciphertext=excluded.ciphertext, iv=excluded.iv, key_version=1,
         created_at=CURRENT_TIMESTAMP, used_at=NULL`,
    ).bind(accountId, codeHash, encrypted.ciphertext, encrypted.iv),
    env.DB.prepare(
      `INSERT INTO audit_events (id,account_id,event_type,outcome,metadata_json)
       VALUES (?,?,?,'success',?)`,
    ).bind(crypto.randomUUID(), accountId, "admin.recovery_code.rotate", JSON.stringify({ rotatedBy: adminId })),
  ]);
  return { recoveryCode: code };
}
