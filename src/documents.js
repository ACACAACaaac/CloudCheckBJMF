const MAX_DOCUMENT_BYTES = 256 * 1024;
const MAX_CLASSES = 50;
const MAX_LOCATIONS = 50;
const MAX_TASKS = 200;
const MAX_OCCURRENCES = 32;

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function boundedArray(value, field, maximum) {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${field} 数量无效`);
  return value;
}

function safeText(value, field, maximum = 120, required = false) {
  if (typeof value !== "string") throw new Error(`${field} 必须是文字`);
  const text = value.trim();
  if ((required && !text) || text.length > maximum || /[<>\u0000-\u001f]/.test(text)) {
    throw new Error(`${field} 格式无效`);
  }
  return text;
}

function validClass(value) {
  return /^\d{1,20}$/.test(String(value));
}

function validTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value));
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value));
}

function validateSettings(value) {
  if (!plainObject(value)) throw new Error("settings must be a JSON object");
  for (const field of ["classes", "excludedClasses"]) {
    if (value[field] === undefined) continue;
    for (const classId of boundedArray(value[field], field, MAX_CLASSES)) {
      if (!validClass(classId)) throw new Error(`${field} 只能包含有效班级号`);
    }
  }
  if (value.username !== undefined) safeText(String(value.username), "用户名", 64);
  if (value.calendarWindowMinutes !== undefined) {
    const minutes = Number(value.calendarWindowMinutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 180) throw new Error("日历签到窗口需为 1 至 180 分钟");
  }
  if (value.polling !== undefined) {
    if (!plainObject(value.polling)) throw new Error("轮询设置格式无效");
    const minutes = Number(value.polling.everyMinutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120) throw new Error("轮询间隔需为 1 至 120 分钟");
    const windows = boundedArray(value.polling.windows, "轮询时间段", 12);
    for (const window of windows) {
      if (!plainObject(window) || !validTime(window.start) || !validTime(window.end)) throw new Error("轮询时间段格式无效");
    }
    if (value.polling.locationGroup !== undefined) safeText(String(value.polling.locationGroup), "默认坐标组", 120);
  }
}

function validateTask(task, repeated = false) {
  if (!plainObject(task)) throw new Error("日历任务格式无效");
  if (task.title !== undefined) safeText(String(task.title), "任务名称", 120);
  if (task.location_group !== undefined) safeText(String(task.location_group), "任务坐标组", 120);
  if (task.course_id !== undefined) safeText(String(task.course_id), "课程标识", 120);
  if (repeated) {
    if (!["daily", "weekly"].includes(task.period)) throw new Error("重复任务周期无效");
    if (!validDate(task.start_date) || !validDate(task.end_date) || task.start_date > task.end_date) throw new Error("重复任务日期无效");
    for (const occurrence of boundedArray(task.occurrences, "重复任务时间", MAX_OCCURRENCES)) {
      if (!plainObject(occurrence) || !validTime(occurrence.start_time)
        || (task.period === "weekly" && (!Number.isInteger(Number(occurrence.weekday)) || Number(occurrence.weekday) < 1 || Number(occurrence.weekday) > 7))) {
        throw new Error("重复任务时间格式无效");
      }
    }
  } else if (!validDate(task.date) || !validTime(task.start_time)) {
    throw new Error("单次任务日期或时间无效");
  }
}

function validateCalendar(value) {
  if (!plainObject(value)) throw new Error("calendar must be a JSON object");
  const locations = boundedArray(value.locations ?? [], "坐标组", MAX_LOCATIONS);
  const names = new Set();
  for (const entry of locations) {
    if (!plainObject(entry) || !plainObject(entry.location)) throw new Error("坐标组格式无效");
    const name = safeText(String(entry.name), "坐标组名称", 120, true);
    if (names.has(name)) throw new Error("坐标组名称不能重复");
    names.add(name);
    const { lat, lng, acc } = entry.location;
    if (!Number.isFinite(Number(lat)) || Number(lat) < -85.05112878 || Number(lat) > 85.05112878
      || !Number.isFinite(Number(lng)) || Number(lng) < -180 || Number(lng) > 180
      || !Number.isFinite(Number(acc)) || Number(acc) < 1 || Number(acc) > 10_000) throw new Error("坐标组坐标无效");
  }
  const users = boundedArray(value.users ?? [], "日历用户", 5);
  for (const user of users) {
    if (!plainObject(user)) throw new Error("日历用户格式无效");
    safeText(String(user.username), "日历用户名", 64, true);
    const windowMinutes = Number(user.window_minutes ?? 20);
    if (!Number.isInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > 180) throw new Error("日历签到窗口需为 1 至 180 分钟");
    for (const course of boundedArray(user.courses ?? [], "课程", MAX_TASKS)) {
      if (!plainObject(course)) throw new Error("课程格式无效");
      safeText(String(course.name ?? ""), "课程名称", 120, true);
      if (course.location_group !== undefined) safeText(String(course.location_group), "课程坐标组", 120);
    }
    for (const task of boundedArray(user.single_tasks ?? [], "单次任务", MAX_TASKS)) validateTask(task);
    for (const task of boundedArray(user.repeat_tasks ?? [], "重复任务", MAX_TASKS)) validateTask(task, true);
  }
}

export function validateDocument(value, kind) {
  if (!plainObject(value)) {
    throw new Error(`${kind} must be a JSON object`);
  }
  if (kind === "settings") validateSettings(value);
  if (kind === "calendar") validateCalendar(value);
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
  // Stopping invalidates an already queued scheduler alarm immediately.
  if (kind === "settings" && (value.enabled !== true || value.attendanceEnabled !== true)) {
    writes.push(env.DB.prepare(
      `UPDATE scheduler_state SET next_read_at = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE account_id = ?`,
    ).bind(accountId));
  }
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
