import { fetchK8n } from "./k8n-gateway.js";
import { loadSecret } from "./secure-data.js";
import { taskIdsFromHtml } from "./read-only.js";

const USER_AGENT = "Mozilla/5.0 (Linux; Android 9; Mobile) AppleWebKit/537.36 Chrome/116 Mobile Safari/537.36 MicroMessenger/8.0";

function validClassId(value) {
  return /^\d{1,20}$/.test(String(value));
}

function messageFromHtml(html) {
  const match = html.match(/<[^>]+id=["']title["'][^>]*>([\s\S]*?)<\/[^>]+>/i);
  return (match?.[1] ?? "班级魔方未返回明确结果")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
}

async function documents(env, accountId) {
  const row = await env.DB.prepare(
    `SELECT s.document_json AS settings_json, c.document_json AS calendar_json
       FROM user_documents s LEFT JOIN calendar_documents c ON c.account_id = s.account_id
      WHERE s.account_id = ?`,
  ).bind(accountId).first();
  return {
    settings: row?.settings_json ? JSON.parse(row.settings_json) : {},
    calendar: row?.calendar_json ? JSON.parse(row.calendar_json) : { locations: [] },
  };
}

function selectedLocation(settings, calendar) {
  const locations = Array.isArray(calendar.locations) ? calendar.locations : [];
  const preferred = settings.polling?.locationGroup;
  const group = locations.find((item) => item.name === preferred) ?? locations[0];
  const lat = Number(group?.location?.lat);
  const lng = Number(group?.location?.lng);
  if (!group || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error("请先建立坐标组并设置默认轮询坐标");
  }
  return { name: group.name, lat, lng, acc: Math.max(1, Number(group.location?.acc) || 20) };
}

async function record(env, accountId, entry) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO attendance_logs
      (id, account_id, class_id, task_id, outcome, result_text, location_group,
       latitude, longitude, accuracy, source, http_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), accountId, entry.classId, entry.taskId ?? null, entry.outcome,
    entry.resultText, entry.location?.name ?? null, entry.location?.lat ?? null,
    entry.location?.lng ?? null, entry.location?.acc ?? null, entry.source ?? "manual",
    entry.httpStatus ?? null,
  ).run();
  await env.DB.prepare(
    `DELETE FROM attendance_logs WHERE id IN (
       SELECT id FROM attendance_logs
        WHERE account_id = ? AND outcome = ?
        ORDER BY attempted_at DESC LIMIT -1 OFFSET 15
     )`,
  ).bind(accountId, entry.outcome).run();
}

function randomSuffix() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function notify(env, accountId, title, content) {
  const token = await loadSecret(env, accountId, "pushplus_token");
  if (!token) throw new Error("尚未保存 PushPlus Token");
  const payload = JSON.stringify({ token, title, content: `${content}\n\n${randomSuffix()}` });
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch("https://www.pushplus.plus/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        signal: AbortSignal.timeout(12_000),
      });
      const result = await response.json().catch(() => ({}));
      if (response.ok && Number(result.code) === 200) return result;
      lastError = new Error(result.msg || `PushPlus 请求失败：HTTP ${response.status}`);
      if (![408, 429, 500, 502, 503, 504].includes(response.status)) break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("PushPlus 网络请求失败");
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
  }
  throw new Error(`PushPlus 连续 3 次发送失败：${lastError?.message ?? "未知错误"}`);
}

export async function testPushplus(env, accountId) {
  await notify(env, accountId, "PushPlus 验证消息", "验证消息");
  return { sent: true };
}

async function findTasks(env, cookie, classId) {
  const response = await fetchK8n(env, `https://k8n.cn/student/course/${classId}/punchs`, {
    headers: {
      Accept: "text/html,application/xhtml+xml", Cookie: cookie,
      Referer: `https://k8n.cn/student/course/${classId}`, "User-Agent": USER_AGENT,
      "X-Requested-With": "com.tencent.mm",
    },
    redirect: "manual",
  });
  const redirect = response.headers.get("location") ?? "";
  if ([301, 302, 303, 307, 308].includes(response.status) && redirect.includes("/login")) {
    throw new Error("Cookie 已失效，请切换账号重新扫码");
  }
  if (!response.ok) throw new Error(`读取任务失败：HTTP ${response.status}`);
  return taskIdsFromHtml(await response.text());
}

export async function executeAttendanceOnce(env, accountId, options = {}) {
  const { settings, calendar } = await documents(env, accountId);
  const classId = String(options.classId ?? settings.classes?.[0] ?? "");
  if (!validClassId(classId)) throw new Error("尚未识别有效班级");
  const cookie = await loadSecret(env, accountId, "bjmf_cookie");
  if (!cookie) throw new Error("尚未保存 Cookie");
  const taskIds = await findTasks(env, cookie, classId);
  if (!taskIds.length) {
    await record(env, accountId, { classId, outcome: "no_task", resultText: "当前没有签到任务", source: options.source });
    return { outcome: "no_task", classId, taskIds: [], results: [] };
  }
  if (settings.attendanceEnabled !== true) {
    return { outcome: "task_found", classId, taskIds, results: [], writeBlocked: true };
  }

  const location = selectedLocation(settings, calendar);
  const results = [];
  const account = await env.DB.prepare("SELECT display_name FROM accounts WHERE id = ?").bind(accountId).first();
  const username = account?.display_name ?? "用户";
  for (const taskId of taskIds) {
    const previous = await env.DB.prepare(
      `SELECT id FROM attendance_logs WHERE account_id = ? AND class_id = ? AND task_id = ? AND outcome = 'success' LIMIT 1`,
    ).bind(accountId, classId, taskId).first();
    if (previous) {
      results.push({ taskId, outcome: "success", message: "该任务此前已签到，未重复提交" });
      continue;
    }
    const body = new URLSearchParams({
      id: taskId, lat: location.lat.toFixed(8), lng: location.lng.toFixed(8),
      acc: String(location.acc), res: "", gps_addr: "",
    }).toString();
    let response;
    let message;
    try {
      response = await fetchK8n(env, `https://k8n.cn/student/punchs/course/${classId}/${taskId}`, {
        method: "POST",
        headers: {
          Accept: "text/html,application/xhtml+xml", "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          Cookie: cookie, Referer: `https://k8n.cn/student/course/${classId}`,
          "User-Agent": USER_AGENT, "X-Requested-With": "com.tencent.mm",
        },
        body,
        redirect: "manual",
      });
      message = messageFromHtml(await response.text());
    } catch (error) {
      message = error instanceof Error ? `网络请求失败：${error.message}` : "网络请求失败";
    }
    const success = Boolean(response?.ok) && message.includes("签到成功");
    const outcome = success ? "success" : "failure";
    await record(env, accountId, { classId, taskId, outcome, resultText: message, location, source: options.source, httpStatus: response?.status });
    await notify(
      env,
      accountId,
      `${username} ${success ? "成功签到" : "签到失败"}`,
      `${username} ${success ? "成功签到" : "签到失败"}\n时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}\n用户 ID：${accountId}\n班级：${classId}\n任务：${taskId}\n结果：${message}`,
    ).catch((error) => console.error("PushPlus attendance notification failed", error));
    results.push({ taskId, outcome, message });
  }
  return { outcome: results.some((item) => item.outcome === "failure") ? "failure" : "success", classId, taskIds, results };
}

export async function recentAttendanceLogs(env, accountId) {
  const result = {};
  for (const outcome of ["success", "failure", "no_task"]) {
    const rows = await env.DB.prepare(
      `SELECT id, class_id, task_id, outcome, result_text, location_group, source,
              http_status, attempted_at
         FROM attendance_logs WHERE account_id = ? AND outcome = ?
        ORDER BY attempted_at DESC LIMIT 15`,
    ).bind(accountId, outcome).all();
    result[outcome] = (rows.results ?? []).map((row) => ({
      id: row.id, classId: row.class_id, taskId: row.task_id, outcome: row.outcome,
      resultText: row.result_text, locationGroup: row.location_group, source: row.source,
      httpStatus: row.http_status, attemptedAt: row.attempted_at,
    }));
  }
  return result;
}
