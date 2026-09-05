const CATEGORIES = new Set(["bug", "suggestion", "question", "other"]);

export function validateFeedbackImages(images = []) {
  if (!Array.isArray(images) || images.length > 3) throw new Error("最多上传 3 张图片");
  for (const image of images) {
    if (typeof image !== "string" || image.length > 280000 || !/^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(image)) {
      throw new Error("图片格式或大小不符合要求，请重新选择图片");
    }
  }
  return images;
}

export async function feedbackImages(env, account, id) {
  const row = await env.DB.prepare("SELECT images_json FROM feedback WHERE id=? AND (account_id=? OR ?='admin')")
    .bind(id, account.id, account.role).first();
  return row ? JSON.parse(row.images_json) : null;
}

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
  const images = validateFeedbackImages(body.images);
  const feedback = {
    id: crypto.randomUUID(), accountId, category, subject, content,
  };
  await env.DB.prepare(
    `INSERT INTO feedback (id, account_id, category, subject, content, images_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(feedback.id, feedback.accountId, feedback.category, feedback.subject, feedback.content, JSON.stringify(images)).run();
  return { id: feedback.id };
}

export async function adminFeedback(env) {
  const rows = await env.DB.prepare(
    `SELECT f.id, f.category, f.subject, f.content, f.created_at, f.admin_reply, f.admin_reply_at,
            a.display_name, c.login_name, json_array_length(f.images_json) AS image_count
       FROM feedback f
       JOIN accounts a ON a.id=f.account_id
       JOIN auth_credentials c ON c.account_id=f.account_id
      ORDER BY f.created_at DESC
      LIMIT 100`,
  ).all();
  return rows.results ?? [];
}

export async function userFeedback(env, accountId) {
  const rows = await env.DB.prepare(
    `SELECT id, category, subject, content, created_at, admin_reply, admin_reply_at, json_array_length(images_json) AS image_count
       FROM feedback WHERE account_id=? ORDER BY created_at DESC LIMIT 100`,
  ).bind(accountId).all();
  return rows.results ?? [];
}

export async function replyFeedback(env, feedbackId, body) {
  const reply = text(body.reply, "回复内容", 1, 2_000);
  const result = await env.DB.prepare(
    `UPDATE feedback SET admin_reply=?, admin_reply_at=CURRENT_TIMESTAMP WHERE id=?`,
  ).bind(reply, feedbackId).run();
  if (!result.meta?.changes) throw new Error("反馈不存在");
}
