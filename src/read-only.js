import { loadSecret } from "./secure-data.js";
import { fetchK8n } from "./k8n-gateway.js";

const USER_AGENT = "Mozilla/5.0 (Linux; Android 9; Mobile) AppleWebKit/537.36 Chrome/116 Mobile Safari/537.36 MicroMessenger/8.0";

function validClassId(classId) {
  return /^\d{1,20}$/.test(classId);
}

export function taskIdsFromHtml(html) {
  return [...html.matchAll(/\bid=["']gps_btn_(\d+)["']/g)].map((match) => match[1]);
}

async function recordObservation(env, accountId, classId, outcome, taskIds, httpStatus) {
  await env.DB.prepare(
    `INSERT INTO readonly_observations
      (id, account_id, class_id, outcome, task_count, task_ids_json, http_status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    accountId,
    classId,
    outcome,
    taskIds.length,
    JSON.stringify(taskIds),
    httpStatus,
  ).run();
}

export async function inspectClassTasks(env, accountId, classId) {
  if (!validClassId(classId)) throw new Error("Invalid class ID");
  const cookie = await loadSecret(env, accountId, "bjmf_cookie");
  if (!cookie) throw new Error("No Cookie is stored for this account");

  const response = await fetchK8n(env, `https://k8n.cn/student/course/${classId}/punchs`, {
    method: "GET",
    redirect: "manual",
    headers: {
      Accept: "text/html,application/xhtml+xml",
      Cookie: cookie,
      Referer: `https://k8n.cn/student/course/${classId}`,
      "User-Agent": USER_AGENT,
      "X-Requested-With": "com.tencent.mm",
    },
    timeoutMs: 10_000,
  });

  const redirect = response.headers.get("location") ?? "";
  if ([301, 302, 303, 307, 308].includes(response.status) && redirect.includes("/login")) {
    await recordObservation(env, accountId, classId, "cookie_invalid", [], response.status);
    return { outcome: "cookie_invalid", taskIds: [], httpStatus: response.status };
  }
  if (!response.ok) {
    await recordObservation(env, accountId, classId, "upstream_error", [], response.status);
    return { outcome: "upstream_error", taskIds: [], httpStatus: response.status };
  }

  const html = await response.text();
  const taskIds = taskIdsFromHtml(html);
  const outcome = taskIds.length > 0 ? "task_found" : "no_task";
  await recordObservation(env, accountId, classId, outcome, taskIds, response.status);
  return { outcome, taskIds, httpStatus: response.status };
}

export async function recentObservations(env, accountId) {
  const result = await env.DB.prepare(
    `SELECT id, class_id, outcome, task_count, task_ids_json, http_status, checked_at
       FROM readonly_observations
      WHERE account_id = ?
      ORDER BY checked_at DESC
      LIMIT 100`,
  ).bind(accountId).all();
  return (result.results ?? []).map((row) => ({
    id: row.id,
    classId: row.class_id,
    outcome: row.outcome,
    taskCount: row.task_count,
    taskIds: JSON.parse(row.task_ids_json),
    httpStatus: row.http_status,
    checkedAt: row.checked_at,
  }));
}
