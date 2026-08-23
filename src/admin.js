import { decryptSecret } from "./secure-data.js";

function parseJson(value, fallback = {}) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function mappedUser(row) {
  return {
    id: row.id,
    displayName: row.display_name,
    loginName: row.login_name,
    status: row.status,
    statusReason: row.status_reason || "",
    role: row.role,
    createdAt: row.created_at,
    settings: { enabled: false, attendanceEnabled: false, classes: [], ...parseJson(row.settings_json) },
    settingsRevision: row.settings_revision ?? 0,
    calendarRevision: row.calendar_revision ?? 0,
    credentials: {
      cookieStored: Boolean(row.cookie_stored),
      pushplusStored: Boolean(row.pushplus_stored),
    },
    recovery: {
      configured: Boolean(row.recovery_created_at),
      revealAvailable: Boolean(row.recovery_secret_stored),
      createdAt: row.recovery_created_at,
      used: Boolean(row.recovery_used_at),
    },
    ai: {
      reputation: Number(row.ai_reputation ?? 100),
      highRisk: Number(row.ai_reputation ?? 100) < 70,
      todayMessages: Number(row.ai_today_messages ?? 0),
      todayNeurons: Number(row.ai_today_neurons ?? 0),
      totalInputTokens: Number(row.ai_input_tokens ?? 0),
      totalOutputTokens: Number(row.ai_output_tokens ?? 0),
      storageBytes: Number(row.storage_bytes ?? 0),
    },
  };
}

export async function adminUsers(env) {
  const rows = await env.DB.prepare(
    `SELECT a.id, a.display_name, a.status, a.status_reason, a.role, a.created_at,
            a.ai_reputation, c.login_name, u.document_json AS settings_json,
            u.revision AS settings_revision, cal.revision AS calendar_revision,
            rc.created_at AS recovery_created_at, rc.used_at AS recovery_used_at,
            EXISTS(SELECT 1 FROM credential_secrets s WHERE s.account_id=a.id AND s.secret_kind='bjmf_cookie') AS cookie_stored,
            EXISTS(SELECT 1 FROM credential_secrets s WHERE s.account_id=a.id AND s.secret_kind='pushplus_token') AS pushplus_stored,
            (rc.ciphertext IS NOT NULL AND rc.iv IS NOT NULL) AS recovery_secret_stored,
            (SELECT COUNT(*) FROM ai_usage_events e WHERE e.account_id=a.id AND e.score IS NOT NULL
              AND datetime(e.created_at)>=datetime('now','start of day')) AS ai_today_messages,
            (SELECT COALESCE(SUM(e.estimated_neurons),0) FROM ai_usage_events e WHERE e.account_id=a.id
              AND datetime(e.created_at)>=datetime('now','start of day')) AS ai_today_neurons,
            (SELECT COALESCE(SUM(e.input_tokens),0) FROM ai_usage_events e WHERE e.account_id=a.id) AS ai_input_tokens,
            (SELECT COALESCE(SUM(e.output_tokens),0) FROM ai_usage_events e WHERE e.account_id=a.id) AS ai_output_tokens,
            COALESCE(LENGTH(u.document_json),0) + COALESCE(LENGTH(cal.document_json),0)
              + COALESCE((SELECT SUM(LENGTH(m.content)+LENGTH(m.metadata_json)) FROM ai_messages m WHERE m.account_id=a.id),0)
              + COALESCE((SELECT LENGTH(mem.content)+LENGTH(mem.summary_content)+LENGTH(mem.context_json) FROM ai_user_memory mem WHERE mem.account_id=a.id),0)
              AS storage_bytes
       FROM accounts a JOIN auth_credentials c ON c.account_id=a.id
       LEFT JOIN user_documents u ON u.account_id=a.id
       LEFT JOIN calendar_documents cal ON cal.account_id=a.id
       LEFT JOIN recovery_codes rc ON rc.account_id=a.id
      ORDER BY a.created_at DESC LIMIT 100`,
  ).all();
  return (rows.results ?? []).map(mappedUser);
}

export async function adminUserDetail(env, accountId) {
  if (!/^[0-9a-f-]{36}$/i.test(accountId)) throw new Error("Invalid account ID");
  const user = (await adminUsers(env)).find((item) => item.id === accountId);
  if (!user) throw new Error("User not found");
  const [logs, scores] = await Promise.all([
    env.DB.prepare(
      `SELECT class_id, task_id, outcome, result_text, source, attempted_at
         FROM attendance_logs WHERE account_id=? ORDER BY attempted_at DESC LIMIT 45`,
    ).bind(accountId).all(),
    env.DB.prepare(
      `SELECT score, score_reason, estimated_neurons, input_tokens, output_tokens, created_at
         FROM ai_usage_events WHERE account_id=? AND score IS NOT NULL
        ORDER BY created_at DESC LIMIT 30`,
    ).bind(accountId).all(),
  ]);
  return { user, logs: logs.results ?? [], aiScores: scores.results ?? [] };
}

export async function revealRecoveryCode(env, adminId, accountId) {
  if (!/^[0-9a-f-]{36}$/i.test(accountId)) throw new Error("Invalid account ID");
  const target = await env.DB.prepare(
    `SELECT a.id, r.ciphertext, r.iv FROM accounts a
       LEFT JOIN recovery_codes r ON r.account_id=a.id WHERE a.id=?`,
  ).bind(accountId).first();
  if (!target) throw new Error("User not found");
  if (!target.ciphertext || !target.iv) throw new Error("该账号创建时未加密保存恢复密钥，需要用户执行一次账号恢复以生成新密钥");
  const recoveryCode = await decryptSecret(env, accountId, "recovery_code", {
    ciphertext: target.ciphertext,
    iv: target.iv,
  });
  await env.DB.prepare(
    `INSERT INTO audit_events (id,account_id,event_type,outcome,metadata_json)
     VALUES (?,?,?,'success',?)`,
  ).bind(crypto.randomUUID(), accountId, "admin.recovery_code.reveal", JSON.stringify({ viewedBy: adminId })).run();
  return { recoveryCode };
}

export async function setAdminUserStatus(env, adminId, accountId, status) {
  if (accountId === adminId) throw new Error("管理员不能封禁自己");
  if (!["active", "suspended"].includes(status)) throw new Error("Invalid account status");
  const target = await env.DB.prepare("SELECT id, role, status FROM accounts WHERE id=?").bind(accountId).first();
  if (!target) throw new Error("User not found");
  if (target.role === "admin") throw new Error("不能通过此页面封禁其他管理员");
  const activating = status === "active" && target.status === "suspended";
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE accounts SET status=?, status_reason='',
        ai_reputation=CASE WHEN ? THEN 80 ELSE ai_reputation END,
        ai_reputation_baseline=CASE WHEN ? THEN 80 ELSE ai_reputation_baseline END,
        ai_score_reset_at=CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE ai_score_reset_at END,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`,
    ).bind(status, activating ? 1 : 0, activating ? 1 : 0, activating ? 1 : 0, accountId),
    env.DB.prepare("DELETE FROM sessions WHERE account_id=?").bind(accountId),
    env.DB.prepare(
      "INSERT INTO audit_events (id,account_id,event_type,outcome) VALUES (?,?,?,'success')",
    ).bind(crypto.randomUUID(), accountId, `admin.account.${status}`),
  ]);
  return adminUserDetail(env, accountId);
}

export async function deleteAdminUser(env, adminId, accountId, confirmation) {
  if (accountId === adminId) throw new Error("管理员不能删除自己");
  const target = await env.DB.prepare(
    `SELECT a.id, a.role, c.login_name FROM accounts a
       JOIN auth_credentials c ON c.account_id=a.id WHERE a.id=?`,
  ).bind(accountId).first();
  if (!target) throw new Error("User not found");
  if (target.role === "admin") throw new Error("不能通过此页面删除其他管理员");
  if (String(confirmation ?? "").trim().toLowerCase() !== target.login_name) throw new Error("请输入完整用户名确认删除");
  await env.DB.prepare("DELETE FROM accounts WHERE id=?").bind(accountId).run();
  return { deleted: true, accountId };
}
