import { CALENDAR_AI_PROMPT } from "./calendar-ai-prompt.js";
import { previousCalendarDocument, readDocument, writeDocument } from "./documents.js";
import { calendarToRules, humanizeOperations, operationsToProtocol, parseAiRuleProtocol } from "./calendar-rules.js";

const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
const VISION_MODEL = "@cf/moondream/moondream3.1-9B-A2B";
const VISION_LICENSE_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const MEMORY_LIMIT = 8_000;
const MESSAGE_LIMIT = 30;
const CONTEXT_MESSAGES = 12;
const USER_DAILY_MESSAGES = 12;
const GLOBAL_DAILY_NEURONS = 9_000;
const CONTEXT_START = "<!-- AUTOCHECK_CONTEXT_START -->";
const CONTEXT_END = "<!-- AUTOCHECK_CONTEXT_END -->";
const AI_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: true,
  properties: {
    reply: { type: "string" },
    score: { type: "number" },
    score_reason: { type: "string" },
    changes: { type: "array", items: { type: "string" } },
    operations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string" }, title: { type: "string" }, name: { type: "string" },
          location_group: { type: "string" }, course_id: { type: "string" },
          period: { type: "string" }, start_date: { type: "string" },
          end_date: { type: "string" }, date: { type: "string" },
          start_time: { type: "string" }, start_times: { type: "array", items: { type: "string" } }, weekday: { type: "number" }, weekdays: { type: "array", items: { type: "number" } },
          window_minutes: { type: "number" }, task_id: { type: "string" }, enabled: { type: "boolean" },
          lat: { type: "number" }, lng: { type: "number" }, acc: { type: "number" },
          old_name: { type: "string" }, occurrence_index: { type: "number" },
        },
        required: ["type"],
      },
    },
  },
  required: ["reply", "score", "score_reason", "operations"],
};

async function runCalendarModel(env, messages) {
  const input = {
    messages,
    max_tokens: 1_400,
    temperature: 0.1,
    response_format: { type: "json_schema", json_schema: AI_RESPONSE_SCHEMA },
  };
  try {
    return await env.AI.run(MODEL, input);
  } catch (error) {
    // Older Workers AI model revisions may not accept JSON Schema. Keep the legacy parser as a safe fallback.
    return env.AI.run(MODEL, { messages, max_tokens: 1_400, temperature: 0.1 });
  }
}

function shanghaiTime(value) {
  const date = new Date(String(value).replace(" ", "T") + "Z");
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(date);
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function cleanLine(value, limit = 500) {
  return String(value ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, limit);
}

function displayMessage(row) {
  const metadata = parseJson(row.metadata_json ?? "{}", {});
  const legacyDeployment = metadata.kind === "deployment"
    || /^已部署到打卡日历(?:，当前日历版本为\s*\d+)?/u.test(row.content);
  return {
    id: row.id,
    role: row.role,
    content: legacyDeployment
      ? "已部署到打卡日历并立即生效。你现在打开“打卡日历”就能看到新任务。"
      : row.content,
    metadata: legacyDeployment ? { ...metadata, kind: "deployment", system: true } : metadata,
    createdAt: row.created_at,
    displayTime: shanghaiTime(row.created_at),
  };
}

async function memoryRow(env, accountId) {
  const row = await env.DB.prepare(
    "SELECT content, summary_content, context_json, updated_at FROM ai_user_memory WHERE account_id = ?",
  ).bind(accountId).first();
  return {
    content: row?.content ?? "# 用户记忆\n",
    summary: row?.summary_content ?? "",
    context: parseJson(row?.context_json ?? "{}", { college: "", locations: {}, courses: {} }),
    updatedAt: row?.updated_at ?? null,
  };
}

async function recentRows(env, accountId, limit = MESSAGE_LIMIT) {
  const rows = await env.DB.prepare(
    `SELECT id, role, content, metadata_json, created_at FROM ai_messages
      WHERE account_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
  ).bind(accountId, limit).all();
  return (rows.results ?? []).reverse();
}

async function calendarContext(env, accountId) {
  const document = await readDocument(env, accountId, "calendar");
  const account = await env.DB.prepare("SELECT display_name FROM accounts WHERE id=?").bind(accountId).first();
  const username = account?.display_name ?? "当前用户";
  let row = await env.DB.prepare("SELECT rules_text FROM calendar_rule_documents WHERE account_id=?").bind(accountId).first();
  if (!row) {
    const rulesText = calendarToRules(document.document, username);
    await env.DB.prepare(
      "INSERT INTO calendar_rule_documents (account_id,rules_text,updated_at) VALUES (?,?,CURRENT_TIMESTAMP)",
    ).bind(accountId, rulesText).run();
    row = { rules_text: rulesText };
  }
  return { username, calendar: document.document, revision: document.revision, rulesText: row.rules_text };
}

function currentCalendarUser(calendar, username) {
  const matches = (calendar.users ?? []).filter((user) => user.username === username);
  return matches.length === 1 ? matches[0] : null;
}

function contextRequirements(calendar, username, context = {}) {
  const user = currentCalendarUser(calendar, username);
  const locations = (calendar.locations ?? []).map((item) => String(item.name));
  const courses = (user?.courses ?? []).map((item) => ({ id: String(item.id), name: String(item.name) }));
  const normalized = {
    college: cleanLine(context.college, 200),
    locations: Object.fromEntries(locations.map((name) => [name, cleanLine(context.locations?.[name])])),
    courses: Object.fromEntries(courses.map((course) => [course.id, cleanLine(context.courses?.[course.id])])),
  };
  const missing = [];
  if (!normalized.college) missing.push("学院名称");
  for (const name of locations) if (!normalized.locations[name]) missing.push(`坐标“${name}”的说明`);
  for (const course of courses) if (!normalized.courses[course.id]) missing.push(`课程“${course.name}”的昵称或说明`);
  return { normalized, missing, locations, courses, calendarUserReady: Boolean(user) };
}

function contextMarkdown(requirements) {
  return [
    CONTEXT_START,
    "## 日历 AI 基础资料（由设置表单维护）",
    `- 学院：${requirements.normalized.college}`,
    "### 坐标说明",
    ...requirements.locations.map((name) => `- ${name}：${requirements.normalized.locations[name]}`),
    "### 课程昵称与说明",
    ...requirements.courses.map((course) => `- ${course.name}（${course.id}）：${requirements.normalized.courses[course.id]}`),
    CONTEXT_END,
  ].join("\n");
}

function replaceContextBlock(content, block) {
  const start = content.indexOf(CONTEXT_START);
  const end = content.indexOf(CONTEXT_END);
  const custom = start >= 0 && end >= start
    ? `${content.slice(0, start)}${content.slice(end + CONTEXT_END.length)}`.trim()
    : content.trim();
  return `${block}\n\n${custom || "# 其他长期记忆"}`.trim();
}

async function quotaState(env, accountId, role) {
  const [userRow, globalRow] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS count FROM ai_usage_events
        WHERE account_id=? AND datetime(created_at) >= datetime('now','start of day') AND score IS NOT NULL`,
    ).bind(accountId).first(),
    env.DB.prepare(
      `SELECT COALESCE(SUM(estimated_neurons),0) AS neurons FROM ai_usage_events
        WHERE datetime(created_at) >= datetime('now','start of day')`,
    ).first(),
  ]);
  return {
    usedMessages: Number(userRow?.count ?? 0),
    messageLimit: role === "admin" ? null : USER_DAILY_MESSAGES,
    adminUnlimited: role === "admin",
    globalEstimatedNeurons: Number(globalRow?.neurons ?? 0),
    globalSoftLimitNeurons: GLOBAL_DAILY_NEURONS,
  };
}

async function pendingProposal(env, accountId) {
  const row = await env.DB.prepare(
    "SELECT proposal_id, summary_json, base_revision, created_at FROM ai_pending_calendars WHERE account_id=?",
  ).bind(accountId).first();
  return row ? {
    id: row.proposal_id,
    summary: parseJson(row.summary_json, []),
    baseRevision: row.base_revision,
    createdAt: row.created_at,
  } : null;
}

async function visionLicenseAccepted(env) {
  const row = await env.DB.prepare("SELECT value FROM system_meta WHERE key='vision_license_accepted'").first();
  return row?.value === "true";
}

async function rememberVisionLicense(env) {
  await env.DB.prepare(
    `INSERT INTO system_meta (key,value,updated_at) VALUES ('vision_license_accepted','true',CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value='true', updated_at=CURRENT_TIMESTAMP`,
  ).run();
}

export async function aiConversation(env, account) {
  await recoverStaleTurn(env, account);
  const [memory, messages, calendar, pending, quota, visionAccepted, activeTurn] = await Promise.all([
    memoryRow(env, account.id), recentRows(env, account.id), calendarContext(env, account.id),
    pendingProposal(env, account.id), quotaState(env, account.id, account.role), visionLicenseAccepted(env),
    env.DB.prepare(
      "SELECT id,status,phase,created_at,updated_at FROM ai_turns WHERE account_id=? AND status='running' ORDER BY created_at DESC LIMIT 1",
    ).bind(account.id).first(),
  ]);
  const requirements = contextRequirements(calendar.calendar, calendar.username, memory.context);
  return {
    model: MODEL, interactive: true, memory: memory.content, autoSummary: memory.summary,
    memoryUpdatedAt: memory.updatedAt,
    context: {
      college: requirements.normalized.college,
      locations: requirements.locations.map((name) => ({ name, description: requirements.normalized.locations[name] })),
      courses: requirements.courses.map((course) => ({ ...course, description: requirements.normalized.courses[course.id] })),
      missing: requirements.missing,
      ready: requirements.calendarUserReady && requirements.missing.length === 0,
      calendarUserReady: requirements.calendarUserReady,
    },
    quota,
    vision: { enabled: visionAccepted, model: VISION_MODEL },
    reputation: { score: Number(account.ai_reputation ?? 100), highRisk: Number(account.ai_reputation ?? 100) < 70 },
    pending,
    activeTurn: activeTurn ? { id: activeTurn.id, status: activeTurn.status, phase: activeTurn.phase, createdAt: activeTurn.created_at, updatedAt: activeTurn.updated_at } : null,
    messages: messages.map(displayMessage),
  };
}

export async function saveAiMemory(env, accountId, content) {
  let normalized = String(content ?? "").trim();
  const [calendar, memory] = await Promise.all([calendarContext(env, accountId), memoryRow(env, accountId)]);
  const requirements = contextRequirements(calendar.calendar, calendar.username, memory.context);
  if (requirements.calendarUserReady && requirements.missing.length === 0) {
    normalized = replaceContextBlock(normalized, contextMarkdown(requirements));
  }
  if (normalized.length > MEMORY_LIMIT) throw new Error("用户.md 不能超过 8000 个字符");
  const value = normalized || "# 用户记忆";
  await env.DB.prepare(
    `INSERT INTO ai_user_memory (account_id, content, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(account_id) DO UPDATE SET content=excluded.content, updated_at=CURRENT_TIMESTAMP`,
  ).bind(accountId, value).run();
  return memoryRow(env, accountId);
}

export async function saveAiContext(env, accountId, value) {
  const [calendar, memory] = await Promise.all([calendarContext(env, accountId), memoryRow(env, accountId)]);
  const requirements = contextRequirements(calendar.calendar, calendar.username, value ?? {});
  if (!requirements.calendarUserReady) throw new Error("请先在打卡日历中保存当前用户，再填写 AI 资料");
  if (requirements.missing.length) throw new Error(`还需填写：${requirements.missing.join("、")}`);
  const content = replaceContextBlock(memory.content, contextMarkdown(requirements));
  if (content.length > MEMORY_LIMIT) throw new Error("写入基础资料后用户.md 超过 8000 字，请先精简其他记忆");
  await env.DB.prepare(
    `INSERT INTO ai_user_memory (account_id, content, context_json, updated_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(account_id) DO UPDATE SET content=excluded.content,
       context_json=excluded.context_json, updated_at=CURRENT_TIMESTAMP`,
  ).bind(accountId, content, JSON.stringify(requirements.normalized)).run();
  return { memory: await memoryRow(env, accountId), requirements };
}

async function enforceRateLimit(env, account) {
  const minute = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM ai_messages WHERE account_id=? AND role='user'
      AND datetime(created_at) >= datetime('now','-1 minute')`,
  ).bind(account.id).first();
  if (Number(minute?.count ?? 0) >= 5) throw new Error("发送得有点快，请一分钟后再试");
  const quota = await quotaState(env, account.id, account.role);
  if (quota.messageLimit !== null && quota.usedMessages >= quota.messageLimit) {
    throw new Error(`今天的 ${quota.messageLimit} 条 AI 额度已用完，北京时间早上 8 点重置`);
  }
  if (quota.globalEstimatedNeurons >= GLOBAL_DAILY_NEURONS) {
    throw new Error("今天的全站 AI 免费额度接近上限，北京时间早上 8 点后再来");
  }
}

function usageFor(messages, response, output) {
  const inputChars = messages.reduce((sum, item) => sum + String(item.content ?? "").length, 0);
  const outputChars = output.length;
  const inputTokens = Number(response?.usage?.prompt_tokens ?? Math.ceil(inputChars / 2));
  const outputTokens = Number(response?.usage?.completion_tokens ?? Math.ceil(outputChars / 2));
  return {
    inputChars, outputChars, inputTokens, outputTokens,
    neurons: (inputTokens * 4_119 + outputTokens * 34_868) / 1_000_000,
  };
}

async function updateReputation(env, account, score, reason, usage) {
  await env.DB.prepare(
    `INSERT INTO ai_usage_events
      (id,account_id,input_chars,output_chars,input_tokens,output_tokens,estimated_neurons,score,score_reason)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).bind(crypto.randomUUID(), account.id, usage.inputChars, usage.outputChars,
    usage.inputTokens, usage.outputTokens, usage.neurons, score, reason).run();
  const state = await env.DB.prepare(
    "SELECT ai_reputation_baseline, ai_score_reset_at, role FROM accounts WHERE id=?",
  ).bind(account.id).first();
  const rows = await env.DB.prepare(
    `SELECT id, score FROM ai_usage_events WHERE account_id=? AND score IS NOT NULL
      AND (? IS NULL OR datetime(created_at) >= datetime(?)) ORDER BY created_at DESC LIMIT 31`,
  ).bind(account.id, state?.ai_score_reset_at ?? null, state?.ai_score_reset_at ?? null).all();
  const scores = rows.results ?? [];
  if (scores.length > 30) {
    await env.DB.prepare("UPDATE ai_usage_events SET score=NULL, score_reason='' WHERE id=?").bind(scores[30].id).run();
  }
  const active = scores.slice(0, 30);
  let reputation = Number(state?.ai_reputation_baseline ?? 100);
  if (active.length) {
    let weighted = 0;
    let weights = 0;
    active.forEach((item, index) => {
      const weight = 0.9 ** index;
      weighted += Number(item.score) * weight;
      weights += weight;
    });
    reputation = weighted / weights;
  }
  const suspended = reputation < 0 && state?.role !== "admin";
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE accounts SET ai_reputation=?, status=CASE WHEN ? THEN 'suspended' ELSE status END,
       status_reason=CASE WHEN ? THEN 'ai_reputation' ELSE status_reason END,
       updated_at=CURRENT_TIMESTAMP WHERE id=?`,
    ).bind(reputation, suspended ? 1 : 0, suspended ? 1 : 0, account.id),
    ...(suspended ? [env.DB.prepare("DELETE FROM sessions WHERE account_id=?").bind(account.id)] : []),
  ]);
  return { score, reason, reputation: Number(reputation.toFixed(1)), highRisk: reputation < 70, suspended };
}

async function recordUsageWithoutScore(env, accountId, usage) {
  await env.DB.prepare(
    `INSERT INTO ai_usage_events
      (id,account_id,input_chars,output_chars,input_tokens,output_tokens,estimated_neurons)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(crypto.randomUUID(), accountId, usage.inputChars, usage.outputChars,
    usage.inputTokens, usage.outputTokens, usage.neurons).run();
}

async function describeImages(env, accountId, images) {
  if (!Array.isArray(images) || !images.length) return { text: "", error: "" };
  if (images.length > 3) throw new Error("一次最多添加 3 张图片");
  const descriptions = [];
  for (const [index, image] of images.entries()) {
    const data = String(image?.data ?? "");
    const type = String(image?.type ?? "");
    if (!/^image\/(jpeg|png|webp)$/i.test(type) || !/^[A-Za-z0-9+/=]+$/.test(data)) {
      throw new Error(`第 ${index + 1} 张图片格式无效，请使用 JPG、PNG 或 WebP`);
    }
    if (data.length > 8_000_000) throw new Error(`第 ${index + 1} 张图片过大，请压缩后重试`);
    const prompt = "请做通用中文 OCR：准确读取图片中的标题、正文、日期、时间、地点和表格文字，并简要说明图片内容。如果它是课表或签到安排，再结构化提取课程、星期、日期、开始时间和地点；如果不是课表也必须照常识别，明确说明与日历无关。看不清就标注，不要猜测。只输出简洁中文纯文本。";
    let response;
    try {
      const binary = atob(data);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      response = await env.AI.toMarkdown(
        { name: cleanLine(image.name, 120) || `image-${index + 1}.jpg`, blob: new Blob([bytes], { type }) },
        { conversionOptions: { image: { descriptionLanguage: "zh" }, output: { format: "text" } } },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/5016|agreement|agree|license|terms/i.test(message)) {
        throw new Error("图片识别尚未由管理员授权，请联系管理员在 AI 助手中同意 Meta 图片模型许可");
      }
      return { text: "", error: `第 ${index + 1} 张图片识别失败：${message}` };
    }
    const converted = Array.isArray(response) ? response[0] : response;
    let output = String(converted?.data ?? converted?.result?.data ?? "").trim();
    if (!output) {
      try {
        const fallback = await env.AI.run(VISION_MODEL, {
          task: "query", image: `data:${type.toLowerCase()};base64,${data}`,
          question: prompt, reasoning: false, stream: false, max_tokens: 1_600, temperature: 0,
        });
        output = String(fallback?.answer ?? fallback?.result?.answer ?? fallback?.response ?? fallback?.caption ?? "").trim();
        response = fallback;
      } catch { /* The stable failure reply below handles both OCR providers. */ }
    }
    if (!output) return { text: "", error: `第 ${index + 1} 张图片没有识别出内容` };
    await recordUsageWithoutScore(env, accountId, usageFor([{ role: "user", content: prompt }], response, output));
    descriptions.push(`[图片 ${index + 1}：${cleanLine(image.name, 120) || "未命名"}]\n${output}`);
  }
  return { text: descriptions.join("\n\n"), error: "" };
}

function jsonCandidates(raw) {
  if (raw && typeof raw === "object") return [raw];
  const cleaned = String(raw ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const candidates = [cleaned];
  let depth = 0;
  let start = -1;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < cleaned.length; index += 1) {
    const char = cleaned[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) candidates.push(cleaned.slice(start, index + 1));
    }
  }
  return candidates.flatMap((candidate) => {
    try { return [JSON.parse(candidate)]; } catch { return []; }
  });
}

function parseStructuredResponse(raw) {
  const candidates = jsonCandidates(raw);
  const value = candidates.find((item) => item && typeof item === "object" && !Array.isArray(item));
  if (!value) throw new Error("AI 回复未能转换为日历操作，请重试；本次不会修改日历");
  const directProposal = ["window_minutes", "courses", "single_tasks", "repeat_tasks"]
    .some((key) => Object.hasOwn(value, key)) ? value : null;
  const reply = cleanLine(value.reply ?? value.message ?? value.answer ?? value.content, 4_000)
    || (directProposal ? "已整理出日历改动，请确认后部署。" : "已处理你的日历请求。");
  if (!reply) throw new Error("AI 没有提供可读回复，请重试");
  const numericScore = Number(value.score ?? value.reputation_score ?? 100);
  return {
    reply,
    score: Math.max(-1_000, Math.min(100, Math.round(numericScore))),
    scoreReason: cleanLine(value.score_reason, 300) || "日历 AI 自动评估",
    proposal: value.proposal && typeof value.proposal === "object"
      ? value.proposal
      : value.calendar && typeof value.calendar === "object"
        ? (value.calendar.user ?? value.calendar)
        : directProposal,
    operations: Array.isArray(value.operations) ? value.operations : Array.isArray(value.actions) ? value.actions : [],
    changes: Array.isArray(value.changes) ? value.changes.map((item) => cleanLine(item, 200)).filter(Boolean).slice(0, 12) : [],
  };
}

function shanghaiDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
}

function taskId(prefix, title) {
  const slug = String(title ?? "task").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "task";
  return `${prefix}-${slug}-${crypto.randomUUID().slice(0, 8)}`;
}

export function applyCalendarOperations(current, username, operations, previousDocument = null) {
  if (!operations.length) return null;
  if (operations.some((operation) => operation.type === "undo_calendar")) {
    if (operations.length !== 1) throw new Error("撤销操作不能和其他日历改动同时执行");
    if (!previousDocument) throw new Error("目前还没有可撤销的日历历史");
    return structuredClone(previousDocument);
  }
  const candidate = structuredClone(current);
  const next = currentCalendarUser(candidate, username);
  if (!next) throw new Error("当前日历中找不到当前用户");
  let changed = false;
  candidate.locations = Array.isArray(candidate.locations) ? candidate.locations : [];
  next.courses = Array.isArray(next.courses) ? next.courses : [];
  next.single_tasks = Array.isArray(next.single_tasks) ? next.single_tasks : [];
  next.repeat_tasks = Array.isArray(next.repeat_tasks) ? next.repeat_tasks : [];
  for (const operation of operations) {
    const type = String(operation?.type ?? "");
    if (type === "clear_tasks" || type === "clear_calendar") {
      next.single_tasks = [];
      next.repeat_tasks = [];
      changed = true;
      continue;
    }
    if (type === "clear_user_calendar") {
      next.courses = [];
      next.single_tasks = [];
      next.repeat_tasks = [];
      next.window_minutes = 20;
      changed = true;
      continue;
    }
    if (type === "clear_all_calendar") {
      candidate.locations = [];
      next.courses = [];
      next.single_tasks = [];
      next.repeat_tasks = [];
      next.window_minutes = 20;
      changed = true;
      continue;
    }
    if (type === "update_window_minutes") {
      next.window_minutes = Number(operation.window_minutes);
      changed = true;
      continue;
    }
    if (type === "delete_task") {
      const before = next.single_tasks.length + next.repeat_tasks.length;
      next.single_tasks = next.single_tasks.filter((item) => item.id !== operation.task_id);
      next.repeat_tasks = next.repeat_tasks.filter((item) => item.id !== operation.task_id);
      if (before === next.single_tasks.length + next.repeat_tasks.length) throw new Error(`没有找到任务 ID“${operation.task_id}”`);
      changed = true;
      continue;
    }
    if (type === "update_single_task") {
      const task = next.single_tasks.find((item) => item.id === operation.task_id);
      if (!task) throw new Error(`没有找到单次任务 ID“${operation.task_id}”`);
      const course = operation.course_id ? next.courses.find((item) => item.id === operation.course_id) : null;
      Object.assign(task, {
        enabled: operation.enabled !== false, title: cleanLine(course?.name ?? operation.title, 120),
        date: operation.date, start_time: operation.start_time,
        location_group: cleanLine(course?.location_group ?? operation.location_group, 120), course_id: course?.id ?? "",
      });
      changed = true;
      continue;
    }
    if (type === "update_repeat_task") {
      const task = next.repeat_tasks.find((item) => item.id === operation.task_id);
      if (!task) throw new Error(`没有找到重复任务 ID“${operation.task_id}”`);
      const course = operation.course_id ? next.courses.find((item) => item.id === operation.course_id) : null;
      const period = operation.period === "weekly" ? "weekly" : "daily";
      const days = period === "weekly" ? operation.weekdays.map(Number) : [null];
      const times = operation.start_times?.length ? operation.start_times : [operation.start_time];
      Object.assign(task, {
        enabled: operation.enabled !== false, title: cleanLine(course?.name ?? operation.title, 120),
        location_group: cleanLine(course?.location_group ?? operation.location_group, 120), period,
        start_date: operation.start_date, end_date: operation.end_date,
        occurrences: days.flatMap((weekday) => times.map((startTime) => period === "weekly" ? { weekday, start_time: startTime } : { start_time: startTime })),
        excluded_instances: [], course_id: course?.id ?? "",
      });
      changed = true;
      continue;
    }
    if (type === "set_task_enabled") {
      const task = [...next.single_tasks, ...next.repeat_tasks].find((item) => item.id === operation.task_id);
      if (!task) throw new Error(`没有找到任务 ID“${operation.task_id}”`);
      task.enabled = operation.enabled !== false;
      changed = true;
      continue;
    }
    if (type === "exclude_repeat_instance") {
      const task = next.repeat_tasks.find((item) => item.id === operation.task_id);
      if (!task) throw new Error(`没有找到重复任务 ID“${operation.task_id}”`);
      const index = Number(operation.occurrence_index);
      if (!validDate(operation.date) || !Number.isInteger(index) || index < 0 || index >= task.occurrences.length) throw new Error("要跳过的日期或重复时间序号无效");
      task.excluded_instances = [...new Set([...(task.excluded_instances ?? []), `${operation.date}#${index}`])];
      changed = true;
      continue;
    }
    if (type === "add_location") {
      if (candidate.locations.some((item) => normalizedName(item.name) === normalizedName(operation.name))) throw new Error(`坐标组“${operation.name}”已经存在`);
      candidate.locations.push({ name: cleanLine(operation.name, 120), location: { lat: Number(operation.lat), lng: Number(operation.lng), acc: Number(operation.acc ?? 20) } });
      changed = true;
      continue;
    }
    if (type === "update_location") {
      const location = candidate.locations.find((item) => normalizedName(item.name) === normalizedName(operation.old_name));
      if (!location) throw new Error(`没有找到坐标组“${operation.old_name}”`);
      const oldName = location.name;
      location.name = cleanLine(operation.name, 120);
      location.location = { lat: Number(operation.lat), lng: Number(operation.lng), acc: Number(operation.acc ?? 20) };
      [...next.courses, ...next.single_tasks, ...next.repeat_tasks].forEach((item) => {
        if (item.location_group === oldName) item.location_group = location.name;
      });
      changed = true;
      continue;
    }
    if (type === "delete_location") {
      const index = candidate.locations.findIndex((item) => normalizedName(item.name) === normalizedName(operation.name));
      if (index < 0) throw new Error(`没有找到坐标组“${operation.name}”`);
      const name = candidate.locations[index].name;
      const used = [...next.courses, ...next.single_tasks, ...next.repeat_tasks].some((item) => item.location_group === name);
      if (used) throw new Error(`坐标组“${name}”仍被课程或任务使用，请先修改或删除相关项目`);
      candidate.locations.splice(index, 1);
      changed = true;
      continue;
    }
    if (["add_course", "update_course", "delete_course"].includes(type)) {
      if (type === "add_course") {
        const id = cleanLine(operation.course_id, 80) || taskId("course", operation.name);
        if (next.courses.some((item) => item.id === id)) throw new Error(`课程 ID“${id}”已经存在`);
        next.courses.push({ id, name: cleanLine(operation.name, 120), location_group: cleanLine(operation.location_group, 120) });
      } else {
        const course = next.courses.find((item) => item.id === operation.course_id);
        if (!course) throw new Error(`没有找到课程 ID“${operation.course_id}”`);
        if (type === "update_course") {
          course.name = cleanLine(operation.name, 120);
          course.location_group = cleanLine(operation.location_group, 120);
          [...next.single_tasks, ...next.repeat_tasks].filter((item) => item.course_id === course.id).forEach((item) => {
            item.title = course.name; item.location_group = course.location_group;
          });
        } else {
          next.courses = next.courses.filter((item) => item.id !== course.id);
          [...next.single_tasks, ...next.repeat_tasks].filter((item) => item.course_id === course.id).forEach((item) => {
            item.course_id = ""; item.title ||= course.name; item.location_group ||= course.location_group;
          });
        }
      }
      changed = true;
      continue;
    }
    const course = operation.course_id
      ? next.courses.find((item) => item.id === operation.course_id)
      : null;
    const title = cleanLine(course?.name ?? operation.title, 120);
    const locationGroup = cleanLine(course?.location_group ?? operation.location_group, 120);
    if (type === "add_single_task") {
      next.single_tasks.push({
        id: taskId("single", title), enabled: operation.enabled !== false,
        title, date: operation.date, start_time: operation.start_time,
        location_group: locationGroup, course_id: course?.id ?? "",
      });
      changed = true;
    } else if (type === "add_repeat_task") {
      const period = operation.period === "weekly" ? "weekly" : "daily";
      const days = period === "weekly" ? (operation.weekdays ?? [operation.weekday]).map(Number) : [null];
      const times = operation.start_times?.length ? operation.start_times : [operation.start_time];
      const occurrences = days.flatMap((weekday) => times.map((startTime) => period === "weekly"
        ? { weekday, start_time: startTime }
        : { start_time: startTime }));
      next.repeat_tasks.push({
        id: taskId("repeat", title), enabled: operation.enabled !== false,
        title, location_group: locationGroup, period,
        start_date: operation.start_date || shanghaiDate(),
        end_date: operation.end_date || "2099-12-31",
        occurrences, excluded_instances: [], course_id: course?.id ?? "",
      });
      changed = true;
    }
  }
  if (!changed) return null;
  return validateProposal(candidate, username, {
    window_minutes: next.window_minutes, courses: next.courses,
    single_tasks: next.single_tasks, repeat_tasks: next.repeat_tasks,
  });
}

function clearCalendarFallback(text) {
  const normalized = normalizedName(text);
  if (/(撤销|恢复|删除).{0,8}(刚刚|上次|上一).{0,8}(改动|修改|操作)|撤销刚刚/u.test(text)) return {
    reply: "我会恢复到上一次保存前的日历，确认后立即生效。",
    score: 100, scoreReason: "正常的日历撤销请求", changes: ["恢复上一次日历快照"],
    operations: [{ type: "undo_calendar" }], proposal: null,
  };
  const clearVerb = /(清空|清除|删除|移除|取消)/u.test(text);
  const clearTarget = /(所有|全部|一切|日历|配置|当前.{0,6}(签到|打卡|任务)|(?:签到|打卡|任务).{0,6}(所有|全部))/u.test(text);
  if (!clearVerb || !clearTarget) return null;
  const clearAll = /(所有|全部).{0,6}(配置|日历配置)|日历.{0,6}(所有|全部).{0,6}配置/u.test(text);
  const clearUser = !clearAll && /(课程|当前用户).{0,6}(和|与|及)?.{0,6}(任务|日历)/u.test(text);
  const allCheckins = /(所有|全部|一切|全部的).{0,6}(签到|打卡|任务)|(?:签到|打卡|任务).{0,6}(所有|全部)/u.test(text)
    || normalized.includes("删除所有签到") || normalized.includes("清空所有签到");
  const type = clearAll ? "clear_all_calendar" : clearUser ? "clear_user_calendar" : "clear_tasks";
  return {
    reply: clearAll ? "我会清空当前账户的坐标组、课程和全部任务；班级与账号信息会保留。确认后立即生效。"
      : clearUser ? "我会清空当前用户的课程和全部任务，保留坐标组。确认后立即生效。"
        : allCheckins ? "我会删除当前用户的所有签到任务；课程与坐标组会保留。即使当前没有任务，也会生成可确认的清空操作。"
          : "我会清空当前用户的单次任务和重复任务；课程与坐标组会保留。确认后立即生效。",
    score: 100,
    scoreReason: "正常的日历清理请求",
    changes: clearAll ? ["清空坐标组、课程和全部任务", "保留班级与账号信息"]
      : clearUser ? ["清空当前用户的课程和全部任务", "保留坐标组"]
        : ["清空当前用户的全部单次任务与重复任务", "保留课程和坐标组"],
    operations: [{ type }],
    proposal: null,
  };
}

function isCalendarScopeRequest(text, attachment = "", images = []) {
  if (attachment || images?.length) return true;
  return /(签到|打卡|日历|任务|课程|课表|坐标组|坐标|地点|定位|轮询|时间段|签到窗口|班级魔方)/u.test(String(text ?? ""));
}

function applyScorePolicy(text, attachment, images, structured) {
  if (isCalendarScopeRequest(text, attachment, images)) {
    return {
      ...structured,
      score: 100,
      scoreReason: structured.scoreReason?.includes("危险") ? structured.scoreReason : "正常的班级魔方日历/签到功能请求",
    };
  }
  return structured;
}

function dangerousRequest(text) {
  const value = String(text ?? "");
  const manipulation = /(信誉分|评分).{0,12}(改成|设为|打|修改|100|-?1000)|忽略.{0,10}(规则|提示|指令)|系统提示|角色扮演|越权/u;
  const dataTheft = /(其他|全部|所有).{0,8}(用户|账号).{0,12}(日历|数据|信息|cookie|密码|密钥)/iu;
  return manipulation.test(value) || dataTheft.test(value);
}

function normalizedName(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

function mentionedLocation(text, locations) {
  const normalizedText = normalizedName(text);
  return [...locations]
    .sort((a, b) => String(b.name).length - String(a.name).length)
    .find((item) => normalizedName(item.name) && normalizedText.includes(normalizedName(item.name))) ?? null;
}

function inferLocationFromContext(text, locations, descriptions = {}) {
  const explicit = mentionedLocation(text, locations);
  if (explicit) return { location: explicit, candidates: [] };
  const input = normalizedName(text);
  const ignored = new Set(["签到", "打卡", "地点", "坐标", "常常", "经常", "通常", "这里", "用于", "进行", "上课", "活动", "发生", "任务", "课程", "位置", "地址"]);
  const scored = locations.map((location) => {
    const description = String(descriptions?.[location.name] ?? "");
    let score = 0;
    for (const part of description.match(/[\u4e00-\u9fff]{2,}/gu) ?? []) {
      for (let size = 2; size <= Math.min(6, part.length); size += 1) {
        for (let start = 0; start <= part.length - size; start += 1) {
          const keyword = part.slice(start, start + size);
          if (!ignored.has(keyword) && input.includes(keyword)) score = Math.max(score, keyword.length);
        }
      }
    }
    return { location, score };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score);
  if (!scored.length) return { location: null, candidates: [] };
  const best = scored.filter((item) => item.score === scored[0].score);
  return { location: best.length === 1 ? best[0].location : null, candidates: best.map((item) => item.location) };
}

function normalizeOperations(operations, calendar, target) {
  const locations = structuredClone(calendar.locations ?? []);
  const courses = structuredClone(target?.courses ?? []);
  return (operations ?? []).map((operation) => {
    if (["add_course", "update_course"].includes(operation.type)) {
      const matched = locations.find((item) => normalizedName(item.name) === normalizedName(operation.location_group));
      if (!matched) throw new Error(`课程使用的坐标组“${operation.location_group}”不存在`);
      const next = { ...operation, location_group: matched.name };
      if (operation.type === "add_course") courses.push({ id: operation.course_id, name: operation.name, location_group: matched.name });
      else {
        const course = courses.find((item) => item.id === operation.course_id);
        if (course) Object.assign(course, { name: operation.name, location_group: matched.name });
      }
      return next;
    }
    if (["add_location", "update_location"].includes(operation.type)) {
      const lat = Number(operation.lat); const lng = Number(operation.lng); const acc = Number(operation.acc ?? 20);
      if (!operation.name || !Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
        throw new Error("坐标组名称或经纬度无效");
      }
      const next = { ...operation, lat, lng, acc: Number.isFinite(acc) && acc > 0 ? acc : 20 };
      if (operation.type === "add_location") locations.push({ name: operation.name, location: next });
      else {
        const location = locations.find((item) => normalizedName(item.name) === normalizedName(operation.old_name));
        if (location) location.name = operation.name;
      }
      return next;
    }
    if (operation.type === "delete_course") {
      const index = courses.findIndex((item) => item.id === operation.course_id);
      if (index >= 0) courses.splice(index, 1);
      return operation;
    }
    if (operation.type === "delete_location") {
      const index = locations.findIndex((item) => normalizedName(item.name) === normalizedName(operation.name));
      if (index >= 0) locations.splice(index, 1);
      return operation;
    }
    if (!["add_repeat_task", "add_single_task", "update_repeat_task", "update_single_task"].includes(operation.type)) return operation;
    const course = operation.course_id ? courses.find((item) => item.id === operation.course_id) : null;
    const requested = course?.location_group || operation.location_group;
    const matched = locations.find((item) => normalizedName(item.name) === normalizedName(requested));
    if (!requested) throw new Error("这条任务还没有指定签到地点，请先告诉我使用哪个坐标组");
    if (!matched) throw new Error(`没有找到坐标组“${requested}”。可用坐标组：${locations.map((item) => item.name).join("、") || "暂无"}`);
    const next = { ...operation, location_group: matched.name };
    if (["add_repeat_task", "update_repeat_task"].includes(next.type)) {
      next.start_times = [...new Set((next.start_times?.length ? next.start_times : [next.start_time]).map(String))];
      if (!next.start_times.length || next.start_times.some((time) => !validTime(time))) throw new Error("重复任务包含无效时间");
      next.start_time = next.start_times[0];
    }
    if (["add_repeat_task", "update_repeat_task"].includes(next.type) && next.period === "weekly") {
      next.weekdays = [...new Set((next.weekdays ?? [next.weekday]).map(Number))].filter((day) => day >= 1 && day <= 7).sort();
      if (!next.weekdays.length) throw new Error("每周任务还没有明确星期几，请补充星期");
    }
    return next;
  });
}

function actionRequest(text) {
  const value = String(text ?? "");
  if (/(读取|查看|列出|说明|告诉我).{0,30}(不(?:要|需|进行).{0,8}(修改|更改|删除|写入|部署)|只读)/u.test(value)) return false;
  return /(新增|添加|创建|设置|修改|更改|改成|删除|清空|清除|移除|取消|停用|禁用|启用|恢复|撤销|跳过)/u.test(value);
}

function timesFromText(value) {
  return [...String(value ?? "").matchAll(/(?:^|\D)([01]?\d|2[0-3])[:：]([0-5]\d)(?=\D|$)/gu)]
    .map((item) => `${String(Number(item[1])).padStart(2, "0")}:${item[2]}`);
}

function taskLocationName(task, target) {
  return target?.courses?.find((course) => course.id === task.course_id)?.location_group || task.location_group;
}

function deterministicUpdateTaskFallback(text, locations, target) {
  const divider = text.match(/改成|修改为|更改为|改为/u);
  if (!divider || !target) return null;
  const before = text.slice(0, divider.index);
  const after = text.slice((divider.index ?? 0) + divider[0].length);
  const oldTimes = timesFromText(before);
  const newTimes = timesFromText(after);
  if (!oldTimes.length || !newTimes.length) return null;
  const location = mentionedLocation(text, locations);
  const candidates = (target.repeat_tasks ?? []).filter((task) => {
    if (location && taskLocationName(task, target) !== location.name) return false;
    const times = (task.occurrences ?? []).map((item) => item.start_time);
    return oldTimes.every((time) => times.includes(time));
  });
  if (candidates.length !== 1) return {
    reply: candidates.length ? "找到多条可能的重复任务，请说明课程名或更具体的原时间。" : "没有找到包含这些原时间的重复任务；请先读取日历确认任务。",
    score: 100, scoreReason: "正常任务修改请求，需要澄清", changes: [], operations: [], proposal: null,
  };
  const task = candidates[0];
  const weekdays = [...new Set((task.occurrences ?? []).map((item) => Number(item.weekday)).filter(Number.isFinite))].sort();
  return {
    reply: `已整理为将“${task.title || "签到任务"}”的时间从 ${oldTimes.join("、")} 改为 ${newTimes.join("、")}，确认后立即生效。`,
    score: 100, scoreReason: "正常任务修改请求",
    changes: [`修改 ${task.title || task.id} 的签到时间`],
    operations: [{
      type: "update_repeat_task", task_id: task.id, title: task.title, location_group: taskLocationName(task, target),
      period: task.period, weekdays, start_times: [...new Set(newTimes)], start_time: newTimes[0],
      start_date: task.start_date, end_date: task.end_date, course_id: task.course_id ?? "", enabled: task.enabled !== false,
    }], proposal: null,
  };
}

function deterministicDeleteTaskFallback(text, locations, target) {
  if (!/(删除|移除|取消)/u.test(text) || !/(签到|打卡|任务)/u.test(text) || !target) return null;
  const location = mentionedLocation(text, locations);
  const times = timesFromText(text);
  const candidates = [...(target.single_tasks ?? []), ...(target.repeat_tasks ?? [])].filter((task) => {
    if (location && taskLocationName(task, target) !== location.name) return false;
    if (!times.length) return Boolean(location);
    const taskTimes = task.start_time ? [task.start_time] : (task.occurrences ?? []).map((item) => item.start_time);
    return times.every((time) => taskTimes.includes(time));
  });
  if (candidates.length !== 1) return candidates.length
    ? { reply: "找到多条可能的任务，请补充课程名、地点或完整时间后再删除。", score: 100, scoreReason: "正常删除请求，需要澄清", changes: [], operations: [], proposal: null }
    : { reply: "没有找到对应的签到任务；日历不会被修改。", score: 100, scoreReason: "正常删除请求，任务不存在", changes: [], operations: [], proposal: null };
  const task = candidates[0];
  return {
    reply: `已整理为删除任务“${task.title || task.id}”，确认后立即生效。`,
    score: 100, scoreReason: "正常任务删除请求", changes: [`删除 ${task.title || task.id}`],
    operations: [{ type: "delete_task", task_id: task.id }], proposal: null,
  };
}

function deterministicReadCalendarFallback(text, target) {
  if (!target || !/(读取|查看|列出|显示|告诉我|说明).{0,30}(日历|签到|打卡|任务)|(?:日历|签到|打卡|任务).{0,20}(有哪些|什么|情况)/u.test(text)) return null;
  if (actionRequest(text)) return null;
  const tasks = [
    ...(target.single_tasks ?? []).map((task) => `${task.date} ${task.start_time} · ${task.location_group} · ${task.title || "单次任务"}`),
    ...(target.repeat_tasks ?? []).map((task) => {
      const times = [...new Set((task.occurrences ?? []).map((item) => item.start_time))].join("、");
      const days = task.period === "weekly"
        ? `每周${[...new Set((task.occurrences ?? []).map((item) => item.weekday))].sort().join("、")}` : "每天";
      return `${days} ${times} · ${task.location_group} · ${task.title || "重复任务"}`;
    }),
  ];
  return {
    reply: tasks.length ? `目前有 ${tasks.length} 个签到任务：${tasks.join("；")}。` : "目前没有签到任务。",
    score: 100, scoreReason: "正常日历读取请求", changes: [], operations: [], proposal: null,
  };
}

function deterministicCourseFallback(text, locations, descriptions) {
  if (!/(新增|添加|创建).{0,16}(课程|课)/u.test(text)) return null;
  const locationMatch = inferLocationFromContext(text, locations, descriptions);
  const location = locationMatch.location;
  const name = text.match(/(?:名为|叫做?|课程[是为]?)[“"']?([^，,、。；;在]{1,60})/u)?.[1]?.trim()
    || text.match(/(?:新增|添加|创建).{0,12}([\u4e00-\u9fa5A-Za-z0-9]{2,30})课程/u)?.[1]?.trim();
  if (!name) return {
    reply: "我可以新增课程，但还缺少课程名称。请例如说“新增名为高等数学、地点为 E13 的课程”。",
    score: 100, scoreReason: "正常课程请求，信息不完整", changes: [], operations: [], proposal: null,
  };
  if (!location) return {
    reply: locationMatch.candidates.length
      ? `课程“${name}”可能对应多个坐标组：${locationMatch.candidates.map((item) => item.name).join("、")}。请明确选择一个。`
      : `课程“${name}”还缺少固定坐标组。请选择：${locations.map((item) => item.name).join("、") || "请先创建坐标组"}。`,
    score: 100, scoreReason: "正常课程请求，信息不完整", changes: [], operations: [], proposal: null,
  };
  const id = `course-${name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/giu, "-").replace(/^-|-$/g, "").slice(0, 24) || "task"}-${crypto.randomUUID().slice(0, 8)}`;
  return {
    reply: `已整理为新增课程“${name}”，固定坐标组为“${location.name}”。确认后立即生效。`,
    score: 100, scoreReason: "正常课程创建请求",
    changes: [`新增课程 ${name} · ${location.name}`],
    operations: [{ type: "add_course", course_id: id, name, location_group: location.name }], proposal: null,
  };
}

function deterministicWindowFallback(text) {
  if (!/(签到窗口|时间窗口|窗口)/u.test(text)) return null;
  const minutes = Number(text.match(/(\d{1,3})\s*(?:分钟|分)/u)?.[1]);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 180) return {
    reply: "请提供 1 到 180 之间的签到时间窗口分钟数，例如“把签到窗口改成 30 分钟”。",
    score: 100, scoreReason: "正常窗口设置请求，信息不完整", changes: [], operations: [], proposal: null,
  };
  return {
    reply: `已整理为将签到时间窗口改为 ${minutes} 分钟，确认后立即生效。`,
    score: 100, scoreReason: "正常窗口设置请求",
    changes: [`签到时间窗口改为 ${minutes} 分钟`],
    operations: [{ type: "update_window_minutes", window_minutes: minutes }], proposal: null,
  };
}

function deterministicTaskToggleFallback(text, target) {
  const enabled = /(启用|恢复)/u.test(text) ? true : /(停用|禁用|关闭)/u.test(text) ? false : null;
  if (enabled === null || !/(所有|全部|当前).{0,8}(签到|打卡|任务)|(?:签到|打卡|任务).{0,8}(所有|全部)/u.test(text)) return null;
  const tasks = [...(target?.single_tasks ?? []), ...(target?.repeat_tasks ?? [])];
  return {
    reply: tasks.length
      ? `已整理为${enabled ? "启用" : "停用"}当前全部 ${tasks.length} 个签到任务，确认后立即生效。`
      : `当前没有签到任务；本次不会修改日历。`,
    score: 100, scoreReason: "正常任务启停请求",
    changes: tasks.map((task) => `${enabled ? "启用" : "停用"} ${task.title || task.id}`),
    operations: tasks.map((task) => ({ type: "set_task_enabled", task_id: task.id, enabled })), proposal: null,
  };
}

export function deterministicCalendarFallback(text, locations, target = null, descriptions = {}) {
  const reading = deterministicReadCalendarFallback(text, target);
  if (reading) return reading;
  const clear = clearCalendarFallback(text);
  if (clear) return clear;
  const deletion = deterministicDeleteTaskFallback(text, locations, target);
  if (deletion) return deletion;
  const toggle = deterministicTaskToggleFallback(text, target);
  if (toggle) return toggle;
  const window = deterministicWindowFallback(text);
  if (window) return window;
  const course = deterministicCourseFallback(text, locations, descriptions);
  if (course) return course;
  const update = deterministicUpdateTaskFallback(text, locations, target);
  if (update) return update;
  const timeMatches = [...text.matchAll(/(?:^|\D)([01]?\d|2[0-3])[:：]([0-5]\d)(?=\D|$)/gu)];
  const time = timeMatches[0];
  const scheduleIntent = /(签到|打卡|日历|任务)/u.test(text)
    && (/(每天|每日|每周|周[一二三四五六日天1-7]|星期)/u.test(text) || (timeMatches.length > 1 && /同时|都|分别/u.test(text)));
  if (!scheduleIntent || !time) {
    if (/(作文|生成一句话|写代码|讲故事|闲聊)/u.test(text)) return {
      reply: "这个问题不属于打卡日历范围，我只能协助课表、课程、地点和签到安排。",
      score: 0, scoreReason: "与日历完全无关的普通请求", changes: [], operations: [], proposal: null,
    };
    return null;
  }
  const locationMatch = inferLocationFromContext(text, locations, descriptions);
  const location = locationMatch.location;
  if (!location) return {
    reply: locationMatch.candidates.length
      ? `时间已经看懂了，但多个坐标组“${locationMatch.candidates.map((item) => item.name).join("、")}”都可能符合你的描述。请明确选择一个。`
      : `时间已经看懂了，但还缺少签到地点。请选择一个坐标组：${locations.map((item) => item.name).join("、") || "请先创建坐标组"}。`,
    score: 100, scoreReason: "正常日历请求，信息不完整并请求补充", changes: [], operations: [], proposal: null,
  };
  const startTimes = [...new Set(timeMatches.map((item) => `${String(Number(item[1])).padStart(2, "0")}:${item[2]}`))];
  const startTime = startTimes[0];
  const weekly = /每周|星期|周[一二三四五六日天1-7]/u.test(text) && !/(每天|每日)/u.test(text);
  const numeral = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
  const weeklyStart = text.search(/每周|星期|周[一二三四五六日天1-7]/u);
  const daySource = weeklyStart >= 0 ? text.slice(weeklyStart, time.index ?? text.length) : "";
  const weekdays = [...daySource.matchAll(/[1-7一二三四五六日天]/gu)].map((match) => numeral[match[0]] ?? Number(match[0]));
  if (weekly && !weekdays.length) return {
    reply: "我知道这是每周任务，但还不清楚星期几。请补充，例如“每周二、四、六”。",
    score: 100, scoreReason: "正常日历请求，星期信息不完整", changes: [], operations: [], proposal: null,
  };
  const operation = {
    type: "add_repeat_task", title: `${location.name} 签到`, location_group: location.name,
    course_id: "", period: weekly ? "weekly" : "daily", weekdays,
    start_date: shanghaiDate(), end_date: "2099-12-31", start_time: startTime, start_times: startTimes,
  };
  const schedule = weekly ? `每周${weekdays.join("、")}` : "每天";
  const timesText = startTimes.join("、");
  return {
    reply: `已整理为${schedule} ${timesText} 在“${location.name}”签到的长期任务，确认后立即生效。`,
    score: 100,
    scoreReason: "正常的日历创建请求",
    changes: [`新增${schedule} ${timesText} 在“${location.name}”签到的长期重复任务`],
    operations: [operation],
    proposal: null,
  };
}

function resolveFollowupText(text, history, locations) {
  const location = mentionedLocation(text, locations);
  if (!location || String(text).trim().length > String(location.name).length + 4) return text;
  const rows = [...history].reverse();
  const priorUser = rows.find((row) => row.role === "user" && /(?:签到|打卡|日历|任务)/u.test(row.content) && /\d{1,2}[:：]\d{2}/u.test(row.content));
  const priorAssistant = rows.find((row) => row.role === "assistant");
  if (!priorUser || !priorAssistant || !/(缺少|还缺|请选择).{0,12}(地点|坐标组)/u.test(priorAssistant.content)) return text;
  return `${priorUser.content}，地点为${location.name}`;
}

function validDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value)); }
function validTime(value) {
  if (!/^\d{2}:\d{2}$/.test(String(value))) return false;
  const [hour, minute] = value.split(":").map(Number);
  return hour < 24 && minute < 60;
}

function validateProposal(current, username, proposal) {
  const target = currentCalendarUser(current, username);
  if (!target) throw new Error("当前日历中找不到唯一的当前用户，请先保存日历");
  const candidate = structuredClone(current);
  const next = structuredClone(target);
  for (const key of ["window_minutes", "courses", "single_tasks", "repeat_tasks"]) {
    if (proposal[key] !== undefined) next[key] = structuredClone(proposal[key]);
  }
  next.username = target.username;
  next.classes = structuredClone(target.classes ?? []);
  next.window_minutes = Math.max(1, Math.min(180, Number(next.window_minutes ?? 20)));
  for (const key of ["courses", "single_tasks", "repeat_tasks"]) {
    if (!Array.isArray(next[key])) throw new Error(`AI 提案中的 ${key} 不是数组`);
  }
  const locationNames = new Set();
  for (const location of current.locations ?? []) {
    const name = cleanLine(location.name, 120);
    const lat = Number(location.location?.lat); const lng = Number(location.location?.lng); const acc = Number(location.location?.acc ?? 20);
    if (!name || locationNames.has(name)) throw new Error("日历包含重复或空坐标组名称");
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180 || !Number.isFinite(acc) || acc <= 0) throw new Error(`坐标组“${name}”的坐标无效`);
    locationNames.add(name);
  }
  const locations = locationNames;
  const courseIds = new Set();
  for (const course of next.courses) {
    if (!course.id || courseIds.has(course.id)) throw new Error("AI 提案包含重复或空课程 ID");
    if (!locations.has(course.location_group)) throw new Error(`课程“${course.name}”引用了不存在的坐标组`);
    courseIds.add(course.id);
  }
  const taskIds = new Set();
  for (const task of [...next.single_tasks, ...next.repeat_tasks]) {
    if (!task.id || taskIds.has(task.id)) throw new Error("AI 提案包含重复或空任务 ID");
    taskIds.add(task.id);
    if (!locations.has(task.location_group)) throw new Error(`任务“${task.title}”引用了不存在的坐标组`);
    if (task.course_id && !courseIds.has(task.course_id)) throw new Error(`任务“${task.title}”引用了不存在的课程`);
  }
  for (const task of next.single_tasks) {
    if (!validDate(task.date) || !validTime(task.start_time)) throw new Error(`单次任务“${task.title}”的日期或时间无效`);
  }
  for (const task of next.repeat_tasks) {
    if (!validDate(task.start_date) || !validDate(task.end_date) || task.start_date > task.end_date) throw new Error(`重复任务“${task.title}”的日期范围无效`);
    if (!["daily", "weekly"].includes(task.period) || !Array.isArray(task.occurrences)) throw new Error(`重复任务“${task.title}”的周期无效`);
    for (const occurrence of task.occurrences) {
      if (!validTime(occurrence.start_time)) throw new Error(`重复任务“${task.title}”包含无效时间`);
      if (task.period === "weekly" && (!Number.isInteger(Number(occurrence.weekday)) || Number(occurrence.weekday) < 1 || Number(occurrence.weekday) > 7)) throw new Error(`重复任务“${task.title}”包含无效星期`);
    }
  }
  const index = candidate.users.findIndex((user) => user.username === username);
  candidate.users[index] = next;
  return candidate;
}

async function beginTurn(env, accountId, userContent) {
  const turnId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO ai_messages (id,account_id,role,content) VALUES (?,?,'user',?)").bind(messageId, accountId, userContent),
    env.DB.prepare(
      "INSERT INTO ai_turns (id,account_id,user_message_id,status,phase) VALUES (?,?,?,'running','正在读取日历与坐标')",
    ).bind(turnId, accountId, messageId),
  ]);
  return turnId;
}

async function setTurnPhase(env, turnId, phase) {
  await env.DB.prepare(
    "UPDATE ai_turns SET phase=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='running'",
  ).bind(phase, turnId).run();
}

async function finishTurn(env, turnId, accountId, reply, metadata = {}, status = "complete", rawProtocol = "", errorText = "") {
  const current = await env.DB.prepare("SELECT status FROM ai_turns WHERE id=?").bind(turnId).first();
  if (!current || current.status !== "running") return false;
  const assistantId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO ai_messages (id,account_id,role,content,metadata_json) VALUES (?,?,'assistant',?,?)")
      .bind(assistantId, accountId, reply, JSON.stringify(metadata)),
    env.DB.prepare(
      `UPDATE ai_turns SET assistant_message_id=?,status=?,phase=?,error_text=?,raw_protocol=?,updated_at=CURRENT_TIMESTAMP
       WHERE id=?`,
    ).bind(assistantId, status, status === "failed" ? "处理失败" : status === "waiting_confirmation" ? "等待确认" : "已完成", errorText, rawProtocol, turnId),
  ]);
  return true;
}

async function recoverStaleTurn(env, account) {
  const turn = await env.DB.prepare(
    `SELECT id FROM ai_turns WHERE account_id=? AND status='running'
      AND datetime(updated_at)<datetime('now','-2 minutes') ORDER BY created_at LIMIT 1`,
  ).bind(account.id).first();
  if (!turn) return;
  const reply = "上一次 AI 请求因网络中断或运行超时而停止。你的提问仍然保留，日历没有被修改，可以直接重试。";
  const usage = { inputChars: 0, outputChars: reply.length, inputTokens: 0, outputTokens: Math.ceil(reply.length / 2), neurons: 0 };
  await scoredReply(env, account, turn.id, reply, 100, "AI 超时不影响信誉", usage, {
    kind: "failure", status: "failed", errorText: "请求超过两分钟未完成",
  });
}

async function scoredReply(env, account, turnId, reply, score, reason, usage, options = {}) {
  const reputation = await updateReputation(env, account, score, reason, usage);
  await finishTurn(env, turnId, account.id, reply, {
    kind: options.kind ?? "reply", score, scoreReason: reason,
    reputation: reputation.reputation, proposalId: options.proposalId ?? null,
    protocolPreview: options.protocolPreview ?? "", system: Boolean(options.system),
  }, options.status ?? "complete", options.protocolPreview ?? "", options.errorText ?? "");
  return reputation;
}

export async function deployAiCalendar(env, account, proposalId) {
  const pending = await env.DB.prepare("SELECT * FROM ai_pending_calendars WHERE account_id=?").bind(account.id).first();
  if (!pending || (proposalId && pending.proposal_id !== proposalId)) throw new Error("目前没有可部署的日历改动，请先让 AI 生成方案");
  const current = await readDocument(env, account.id, "calendar");
  if (current.revision !== Number(pending.base_revision)) throw new Error("日历在方案生成后已被修改，请让 AI 根据最新版重新生成");
  const document = parseJson(pending.document_json, null);
  if (!document) throw new Error("待部署日历损坏，请重新生成");
  const result = await writeDocument(env, account.id, "calendar", document, current.revision);
  if (result.conflict) throw new Error("日历版本冲突，请刷新后重新生成");
  const reply = "已部署到打卡日历并立即生效。你现在打开“打卡日历”就能看到新任务。";
  await env.DB.batch([
    env.DB.prepare("DELETE FROM ai_pending_calendars WHERE account_id=?").bind(account.id),
    env.DB.prepare("INSERT INTO ai_messages (id,account_id,role,content,metadata_json) VALUES (?,?,'assistant',?,?)")
      .bind(crypto.randomUUID(), account.id, reply, JSON.stringify({ kind: "deployment", system: true })),
  ]);
  return { deployed: true, reply, document: result.document, revision: result.revision };
}

export async function discardAiCalendar(env, accountId, proposalId) {
  const result = await env.DB.prepare("DELETE FROM ai_pending_calendars WHERE account_id=? AND proposal_id=?").bind(accountId, proposalId).run();
  if (!result.meta?.changes) throw new Error("待确认方案不存在或已经处理");
  return { discarded: true };
}

export async function stopAiTurn(env, account) {
  const turn = await env.DB.prepare(
    "SELECT id FROM ai_turns WHERE account_id=? AND status='running' ORDER BY created_at DESC LIMIT 1",
  ).bind(account.id).first();
  if (!turn) return { stopped: false };
  const reply = "已按你的要求终止本次思考。原始提问仍然保留，日历没有被修改。";
  const usage = { inputChars: 0, outputChars: reply.length, inputTokens: 0, outputTokens: Math.ceil(reply.length / 2), neurons: 0 };
  const reputation = await scoredReply(env, account, turn.id, reply, 100, "用户主动终止不影响信誉", usage, {
    kind: "stopped", status: "stopped", errorText: "用户主动终止",
  });
  return { stopped: true, reputation };
}

export async function sendAiMessage(env, account, message, attachmentText = "", images = []) {
  await enforceRateLimit(env, account);
  const text = String(message ?? "").trim();
  const attachment = String(attachmentText ?? "").trim();
  if (!text && !attachment && !images?.length) throw new Error("请输入消息或添加图片、文本文件");
  if (text.length > 4_000) throw new Error("单条消息不能超过 4000 个字符");
  if (attachment.length > 30_000) throw new Error("附件提取文本不能超过 30000 个字符");
  const [{ username, calendar, revision, rulesText }, memory, history] = await Promise.all([
    calendarContext(env, account.id), memoryRow(env, account.id), recentRows(env, account.id, CONTEXT_MESSAGES),
  ]);
  const storedUserContent = [text, attachment ? "（已附加文本文件）" : "", images?.length ? `（已附加 ${images.length} 张图片）` : ""].filter(Boolean).join("\n");
  const turnId = await beginTurn(env, account.id, storedUserContent || "（附件）");
  let usage = { inputChars: text.length + attachment.length, outputChars: 0, inputTokens: 0, outputTokens: 0, neurons: 0 };
  let rawProtocolForFailure = "";
  try {
    const target = currentCalendarUser(calendar, username);
    if (dangerousRequest(text)) {
      const reply = "这个请求涉及操纵评分、绕过规则或访问其他用户数据，我不能执行。当前账号只能管理自己的日历。";
      const reputation = await scoredReply(env, account, turnId, reply, -1000, "试图操纵信誉、绕过规则或访问其他用户数据", usage);
      return { answer: reply, model: MODEL, proposal: null, reputation };
    }
    const requirements = contextRequirements(calendar, username, memory.context);
    if (!requirements.calendarUserReady) throw new Error("请先打开打卡日历并保存一次当前用户资料");
    if (requirements.missing.length) throw new Error(`使用 AI 前请先补全基础资料：${requirements.missing.join("、")}`);

    await setTurnPhase(env, turnId, images?.length ? "正在识别图片文字" : "正在理解你的要求");
    const imageResult = await describeImages(env, account.id, images);
    const imageText = imageResult?.text ?? "";
    if (imageResult?.error) throw new Error(`${imageResult.error}。图片识别失败不会降低信誉分`);
    const userContent = [text, attachment ? `[附件提取文本]\n${attachment}` : "", imageText ? `[图片识别结果]\n${imageText}` : ""].filter(Boolean).join("\n\n");
    const readOnlyImageRequest = images?.length && /(读取|识别|看看|是什么|文字|内容|总结|说明)/u.test(text)
      && !/(加入|添加|创建|设置|修改|更新|部署|清空|删除|写入).{0,8}(日历|任务|课程)/u.test(text);
    if (readOnlyImageRequest) {
      const reply = imageText || "图片中没有识别出可读文字。";
      usage = { inputChars: text.length, outputChars: reply.length, inputTokens: Math.ceil(text.length / 2), outputTokens: Math.ceil(reply.length / 2), neurons: 0 };
      const reputation = await scoredReply(env, account, turnId, reply, 100, "允许的图片识别与日历助手功能测试", usage);
      return { answer: reply, model: VISION_MODEL, proposal: null, reputation };
    }

    const resolvedText = resolveFollowupText(text, history, calendar.locations ?? []);
    const locationDescriptions = requirements.normalized.locations;
    let structured = deterministicCalendarFallback(resolvedText, calendar.locations ?? [], target, locationDescriptions);
    let raw = "";
    let response = null;
    if (!structured) {
      await setTurnPhase(env, turnId, "正在生成可校验的日历规则");
      const messages = [
        { role: "system", content: `${CALENDAR_AI_PROMPT}\n\n本轮系统已启用 JSON 结构约束：请返回 JSON 对象，字段为 reply、score、score_reason、operations。不要输出 Markdown 或其他文字；operations 必须是可执行操作数组，查询或澄清时使用空数组。\n\n当前用户：${username}\n可用坐标组：${(calendar.locations ?? []).map((item) => item.name).join("、")}\n当前紧凑日历规则：\n${rulesText}\n\n用户.md：\n${memory.content}\n\n自动摘要：\n${memory.summary}` },
        ...history.map((row) => ({ role: row.role, content: row.content })),
        { role: "user", content: userContent },
      ];
      response = await runCalendarModel(env, messages);
      const responseBody = response?.response ?? response;
      raw = typeof responseBody === "string" ? responseBody.trim() : JSON.stringify(responseBody ?? {});
      rawProtocolForFailure = raw;
      if (!raw) throw new Error("AI 没有返回任何内容");
      usage = usageFor(messages, response, raw);
      try {
        structured = parseAiRuleProtocol(raw);
      } catch {
        try {
          const legacy = parseStructuredResponse(raw);
          structured = { ...legacy, rawProtocol: operationsToProtocol(legacy.operations, legacy.score, legacy.scoreReason, legacy.reply) };
        } catch {
          structured = deterministicCalendarFallback(resolvedText, calendar.locations ?? [], target, locationDescriptions);
          if (!structured) throw new Error("AI 返回的规则格式不完整，本次没有修改日历");
        }
      }
    }

    const clarification = /信息不完整|缺少|当前没有签到任务/u.test(`${structured.reply ?? ""} ${structured.scoreReason ?? ""}`);
    if (actionRequest(resolvedText) && !(structured.operations ?? []).length && !clarification) {
      throw new Error("AI 没有生成可部署的日历操作；本次没有修改日历。请换一种更明确的说法后重试");
    }
    structured = applyScorePolicy(text, attachment, images, structured);
    const operations = normalizeOperations(structured.operations ?? [], calendar, target);
    const protocolPreview = structured.rawProtocol || operationsToProtocol(operations, structured.score, structured.scoreReason, structured.reply);
    let proposal = null;
    if (operations.length) {
      const undo = operations.some((operation) => operation.type === "undo_calendar")
        ? await previousCalendarDocument(env, account.id) : null;
      const document = applyCalendarOperations(calendar, username, operations, undo?.document ?? null);
      const proposalId = crypto.randomUUID();
      const summary = humanizeOperations(operations);
      await env.DB.prepare(
        `INSERT INTO ai_pending_calendars (account_id,proposal_id,document_json,summary_json,base_revision,created_at)
         VALUES (?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(account_id) DO UPDATE SET
         proposal_id=excluded.proposal_id, document_json=excluded.document_json,
         summary_json=excluded.summary_json, base_revision=excluded.base_revision, created_at=CURRENT_TIMESTAMP`,
      ).bind(account.id, proposalId, JSON.stringify(document), JSON.stringify(summary), revision).run();
      proposal = { id: proposalId, summary, baseRevision: revision };
    }
    const score = Number.isFinite(Number(structured.score)) ? Math.max(-1000, Math.min(100, Math.round(Number(structured.score)))) : 100;
    const reason = cleanLine(structured.scoreReason, 300) || "日历 AI 自动评估";
    const reputation = await scoredReply(env, account, turnId, structured.reply, score, reason, usage, {
      kind: proposal ? "proposal" : "reply", proposalId: proposal?.id,
      protocolPreview, status: proposal ? "waiting_confirmation" : "complete",
    });
    return { answer: structured.reply, model: MODEL, proposal, reputation, protocolPreview };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "未知错误";
    const reply = `这次没有处理成功：${detail}。你的提问已经保留，日历没有被修改；可以补充信息后重试。`;
    usage.outputChars = reply.length;
    const reputation = await scoredReply(env, account, turnId, reply, 100, "处理失败不影响 AI 信誉", usage, {
      kind: "failure", status: "failed", errorText: detail, protocolPreview: rawProtocolForFailure,
    });
    return { answer: reply, model: MODEL, proposal: null, reputation, failed: true };
  }
}

export async function acceptVisionLicense(env, account) {
  if (account.role !== "admin") throw new Error("仅管理员可以完成图片模型授权");
  let response;
  try {
    response = await env.AI.run(VISION_LICENSE_MODEL, { prompt: "agree" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/5016/i.test(message) || !/(thank you|may now use|agree)/i.test(message)) throw error;
    response = { response: message };
  }
  await rememberVisionLicense(env);
  return { accepted: true, model: VISION_LICENSE_MODEL, response: String(response?.response ?? "") };
}

export async function clearAiConversation(env, accountId) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM ai_messages WHERE account_id=?").bind(accountId),
    env.DB.prepare("DELETE FROM ai_pending_calendars WHERE account_id=?").bind(accountId),
    env.DB.prepare("UPDATE ai_user_memory SET summary_content='', updated_at=CURRENT_TIMESTAMP WHERE account_id=?").bind(accountId),
  ]);
  return { cleared: true };
}
