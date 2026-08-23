const MAX_DOCUMENT_BYTES = 256 * 1024;

function validateDocument(value, kind) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${kind} must be a JSON object`);
  }
  const encoded = JSON.stringify(value);
  if (encoded.length > MAX_DOCUMENT_BYTES) throw new Error(`${kind} is too large`);
  return encoded;
}

export async function readDocument(env, accountId, kind) {
  const table = kind === "calendar" ? "calendar_documents" : "user_documents";
  const row = await env.DB.prepare(
    `SELECT document_json, revision, updated_at FROM ${table} WHERE account_id = ?`,
  ).bind(accountId).first();
  if (!row) {
    return {
      document: kind === "calendar" ? { version: 1, locations: [], users: [] } : {},
      revision: 0,
      updatedAt: null,
    };
  }
  return {
    document: JSON.parse(row.document_json),
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

export async function writeDocument(env, accountId, kind, value, expectedRevision) {
  const table = kind === "calendar" ? "calendar_documents" : "user_documents";
  const encoded = validateDocument(value, kind);
  const current = await readDocument(env, accountId, kind);
  if (expectedRevision !== current.revision) {
    return { conflict: true, current };
  }
  const nextRevision = current.revision + 1;
  const writes = [env.DB.prepare(
    `INSERT INTO ${table} (account_id, document_json, revision, updated_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(account_id) DO UPDATE SET
       document_json = excluded.document_json,
       revision = excluded.revision,
       updated_at = CURRENT_TIMESTAMP`,
  ).bind(accountId, encoded, nextRevision)];
  if (kind === "calendar") {
    if (current.revision > 0) {
      writes.push(env.DB.prepare(
        `INSERT INTO calendar_document_history (id,account_id,document_json,revision)
         VALUES (?,?,?,?)`,
      ).bind(crypto.randomUUID(), accountId, JSON.stringify(current.document), current.revision));
      writes.push(env.DB.prepare(
        `DELETE FROM calendar_document_history WHERE account_id=? AND id NOT IN (
           SELECT id FROM calendar_document_history WHERE account_id=? ORDER BY revision DESC, created_at DESC LIMIT 20
         )`,
      ).bind(accountId, accountId));
    }
    const account = await env.DB.prepare("SELECT display_name FROM accounts WHERE id=?").bind(accountId).first();
    const rules = calendarToRules(value, account?.display_name ?? "当前用户");
    writes.push(env.DB.prepare(
      `INSERT INTO calendar_rule_documents (account_id,rules_text,updated_at)
       VALUES (?,?,CURRENT_TIMESTAMP) ON CONFLICT(account_id) DO UPDATE SET
       rules_text=excluded.rules_text, updated_at=CURRENT_TIMESTAMP`,
    ).bind(accountId, rules));
  }
  await env.DB.batch(writes);
  return { conflict: false, ...(await readDocument(env, accountId, kind)) };
}

export async function previousCalendarDocument(env, accountId) {
  const row = await env.DB.prepare(
    `SELECT document_json,revision FROM calendar_document_history
     WHERE account_id=? ORDER BY revision DESC,created_at DESC LIMIT 1`,
  ).bind(accountId).first();
  return row ? { document: JSON.parse(row.document_json), revision: Number(row.revision) } : null;
}
import { calendarToRules } from "./calendar-rules.js";
