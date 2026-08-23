const CATEGORIES = new Set(["bug", "suggestion", "question", "other"]);

function text(value, label, min, max) {
  const normalized = String(value ?? "").trim();
  if (normalized.length < min || normalized.length > max) {
    throw new Error(`${label}需要包含 ${min}-${max} 个字符`);
  }
  return normalized;
}

export async function submitFeedback(env, accountId, body) {
  const category = String(body.category ?? "other");
  if (!CATEGORIES.has(category)) throw new Error("反馈分类无效");
  const subject = text(body.subject, "标题", 2, 120);
  const content = text(body.content, "反馈内容", 5, 2_000);
  const feedback = {
    id: crypto.randomUUID(), accountId, category, subject, content,
  };
  await env.DB.prepare(
    `INSERT INTO feedback (id, account_id, category, subject, content)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(feedback.id, feedback.accountId, feedback.category, feedback.subject, feedback.content).run();
  return { id: feedback.id };
}

export async function adminFeedback(env) {
  const rows = await env.DB.prepare(
    `SELECT f.id, f.category, f.subject, f.content, f.created_at,
            a.display_name, c.login_name
       FROM feedback f
       JOIN accounts a ON a.id=f.account_id
       JOIN auth_credentials c ON c.account_id=f.account_id
      ORDER BY f.created_at DESC
      LIMIT 100`,
  ).all();
  return rows.results ?? [];
}
