import { inspectClassTasks } from "./read-only.js";
import { executeAttendanceOnce } from "./attendance.js";
import { refreshDetectedClasses } from "./cookie-login.js";

const SHANGHAI_OFFSET = "+08:00";
const DAY_MS = 86_400_000;

function shanghaiDateParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${value.year}-${value.month}-${value.day}`,
    weekday: { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[value.weekday],
  };
}

function localDateTime(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const value = new Date(`${date}T${time}:00${SHANGHAI_OFFSET}`);
  return Number.isNaN(value.getTime()) ? null : value;
}

function addLocalDays(date, days) {
  const noon = new Date(`${date}T12:00:00${SHANGHAI_OFFSET}`);
  return shanghaiDateParts(new Date(noon.getTime() + days * DAY_MS)).date;
}

function validTime(value) {
  if (!/^\d{2}:\d{2}$/.test(value)) return false;
  const [hour, minute] = value.split(":").map(Number);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

async function stableOffsetSeconds(key, intervalMinutes) {
  const totalSeconds = Math.max(60, intervalMinutes * 60);
  const minimum = totalSeconds > 62 ? 31 : 1;
  const maximum = totalSeconds > 62 ? totalSeconds - 31 : Math.max(1, totalSeconds - 1);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)),
  );
  const value = new DataView(digest.buffer).getUint32(0, false);
  return minimum + (value % Math.max(1, maximum - minimum + 1));
}

function calendarWindows(calendar, username, date, defaultWindowMinutes) {
  const calendarUser = (calendar.users ?? []).find((user) => user.username === username);
  if (!calendarUser) return [];
  const windowMinutes = Math.max(1, Number(calendarUser.window_minutes ?? defaultWindowMinutes ?? 20));
  const windows = [];

  for (const task of calendarUser.single_tasks ?? []) {
    if (task.enabled === false || task.date !== date || !validTime(task.start_time)) continue;
    const center = localDateTime(date, task.start_time);
    windows.push({
      start: new Date(center.getTime() - windowMinutes * 60_000),
      end: new Date(center.getTime() + windowMinutes * 60_000),
      source: `single:${task.id}`,
    });
  }

  const weekday = shanghaiDateParts(localDateTime(date, "12:00")).weekday;
  for (const group of calendarUser.repeat_tasks ?? []) {
    if (group.enabled === false || date < group.start_date || date > group.end_date) continue;
    for (const [index, occurrence] of (group.occurrences ?? []).entries()) {
      if (!validTime(occurrence.start_time)) continue;
      if (group.period === "weekly" && Number(occurrence.weekday) !== weekday) continue;
      const instanceKey = `${date}#${index}`;
      if ((group.excluded_instances ?? []).includes(instanceKey)) continue;
      const center = localDateTime(date, occurrence.start_time);
      windows.push({
        start: new Date(center.getTime() - windowMinutes * 60_000),
        end: new Date(center.getTime() + windowMinutes * 60_000),
        source: `repeat:${group.id}:${index}`,
      });
    }
  }
  return windows;
}

function ordinaryWindows(settings, date) {
  const configured = settings.polling?.windows ?? settings.schedule?.windows ?? [];
  return configured.flatMap((window, index) => {
    if (!validTime(window.start) || !validTime(window.end)) return [];
    const start = localDateTime(date, window.start);
    let end = localDateTime(date, window.end);
    if (end <= start) end = new Date(end.getTime() + DAY_MS);
    return [{ start, end, source: `ordinary:${index}` }];
  });
}

export async function nextReadTarget(accountId, settings, calendar, after = new Date()) {
  if (settings.enabled === false) return null;
  const intervalMinutes = Math.max(
    1,
    Number(settings.polling?.everyMinutes ?? settings.schedule?.every_minutes ?? 5),
  );
  const today = shanghaiDateParts(after).date;
  const candidates = [];

  for (let dayOffset = -1; dayOffset <= 2; dayOffset += 1) {
    const date = addLocalDays(today, dayOffset);
    const windows = [
      ...ordinaryWindows(settings, date),
      ...calendarWindows(calendar, settings.username ?? "", date, settings.calendarWindowMinutes),
    ];
    for (const window of windows) {
      for (
        let bucket = new Date(window.start);
        bucket < window.end;
        bucket = new Date(bucket.getTime() + intervalMinutes * 60_000)
      ) {
        const bucketEnd = new Date(bucket.getTime() + intervalMinutes * 60_000);
        if (bucketEnd > window.end) break;
        const offset = await stableOffsetSeconds(
          `${accountId}|${date}|${window.source}|${bucket.toISOString()}`,
          intervalMinutes,
        );
        const target = new Date(bucket.getTime() + offset * 1000);
        if (target > after && target <= new Date(window.end.getTime() - 60_000)) {
          candidates.push(target);
        }
      }
    }
  }
  candidates.sort((left, right) => left - right);
  return candidates[0] ?? null;
}

async function accountDocuments(env, accountId) {
  const row = await env.DB.prepare(
    `SELECT u.document_json AS settings_json, c.document_json AS calendar_json
       FROM user_documents u
       LEFT JOIN calendar_documents c ON c.account_id = u.account_id
      WHERE u.account_id = ?`,
  ).bind(accountId).first();
  if (!row) return null;
  return {
    settings: JSON.parse(row.settings_json),
    calendar: row.calendar_json ? JSON.parse(row.calendar_json) : { users: [] },
  };
}

async function saveNextTarget(env, accountId, target, outcome = null) {
  await env.DB.prepare(
    `INSERT INTO scheduler_state (account_id, next_read_at, last_outcome, updated_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(account_id) DO UPDATE SET
       next_read_at = excluded.next_read_at,
       last_outcome = COALESCE(excluded.last_outcome, scheduler_state.last_outcome),
       updated_at = CURRENT_TIMESTAMP`,
  ).bind(accountId, target?.toISOString() ?? null, outcome).run();
}

async function earliestTarget(env) {
  const row = await env.DB.prepare(
    `SELECT next_read_at FROM scheduler_state
      WHERE next_read_at IS NOT NULL ORDER BY next_read_at LIMIT 1`,
  ).first();
  return row?.next_read_at ?? null;
}

export async function reconcileSchedules(env) {
  const rows = await env.DB.prepare(
    `SELECT account_id FROM user_documents ORDER BY account_id LIMIT 100`,
  ).all();
  const now = new Date();
  for (const row of rows.results ?? []) {
    const documents = await accountDocuments(env, row.account_id);
    const target = documents
      ? await nextReadTarget(row.account_id, documents.settings, documents.calendar, now)
      : null;
    await saveNextTarget(env, row.account_id, target);
  }
  return earliestTarget(env);
}

export async function processDueReads(env) {
  const due = await env.DB.prepare(
    `SELECT account_id FROM scheduler_state
      WHERE next_read_at IS NOT NULL AND next_read_at <= ?
      ORDER BY next_read_at LIMIT 20`,
  ).bind(new Date(Date.now() + 2_000).toISOString()).all();
  for (const row of due.results ?? []) {
    try {
      await refreshDetectedClasses(env, row.account_id);
    } catch (error) {
      // Keep the last known classes when the upstream student page is temporarily unavailable.
      console.warn("scheduled class refresh failed", row.account_id, error);
    }
    const documents = await accountDocuments(env, row.account_id);
    if (!documents) continue;
    const results = [];
    for (const classId of documents.settings.classes ?? []) {
      try {
        results.push(documents.settings.attendanceEnabled === true
          ? await executeAttendanceOnce(env, row.account_id, { classId: String(classId), source: "scheduler" })
          : await inspectClassTasks(env, row.account_id, String(classId)));
      } catch (error) {
        console.error("scheduled account run failed", row.account_id, classId, error);
        results.push({ outcome: "failure" });
      }
    }
    const outcome = results.some((result) => result.outcome === "failure")
      ? "failure"
      : results.some((result) => ["task_found", "success"].includes(result.outcome))
        ? "task_found"
        : "no_task";
    const next = await nextReadTarget(
      row.account_id,
      documents.settings,
      documents.calendar,
      new Date(),
    );
    await env.DB.prepare(
      `UPDATE scheduler_state SET next_read_at = ?, last_read_at = CURRENT_TIMESTAMP,
        last_outcome = ?, updated_at = CURRENT_TIMESTAMP WHERE account_id = ?`,
    ).bind(next?.toISOString() ?? null, outcome, row.account_id).run();
  }
  return earliestTarget(env);
}
