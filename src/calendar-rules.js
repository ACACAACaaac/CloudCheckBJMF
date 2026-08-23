function field(value) {
  return JSON.stringify(String(value ?? ""));
}

function parseField(value) {
  const text = String(value ?? "").trim();
  try { return JSON.parse(text); } catch { return text; }
}

export function calendarToRules(calendar, username) {
  const user = (calendar?.users ?? []).find((item) => item.username === username);
  const lines = ["RULES_V1", `USER|${field(username)}`];
  for (const location of calendar?.locations ?? []) {
    lines.push(`LOCATION|${field(location.name)}|${Number(location.location?.lat ?? 0)}|${Number(location.location?.lng ?? 0)}|${Number(location.location?.acc ?? 20)}`);
  }
  if (!user) return lines.join("\n");
  lines.push(`WINDOW|${Math.max(1, Number(user.window_minutes ?? 20))}`);
  for (const course of user.courses ?? []) {
    lines.push(`COURSE|${field(course.id)}|${field(course.name)}|${field(course.location_group)}`);
  }
  for (const task of user.single_tasks ?? []) {
    lines.push([
      "SINGLE", field(task.id), task.enabled === false ? "OFF" : "ON", field(task.title),
      task.date, task.start_time, field(task.location_group), field(task.course_id),
    ].join("|"));
  }
  for (const task of user.repeat_tasks ?? []) {
    const grouped = new Map();
    for (const occurrence of task.occurrences ?? []) {
      const key = occurrence.start_time;
      const days = grouped.get(key) ?? [];
      if (task.period === "weekly") days.push(Number(occurrence.weekday));
      grouped.set(key, days);
    }
    for (const [startTime, days] of grouped) {
      lines.push([
        "REPEAT", field(task.id), task.enabled === false ? "OFF" : "ON", field(task.title),
        task.period, task.start_date, task.end_date,
        task.period === "weekly" ? [...new Set(days)].sort().join(",") : "*",
        startTime, field(task.location_group), field(task.course_id),
      ].join("|"));
    }
  }
  return lines.join("\n");
}

export function parseAiRuleProtocol(raw) {
  const text = String(raw ?? "").trim();
  const scoreMatch = text.match(/(?:^|\n)SCORE\|(-?\d+)(?:\|([^\n]*))?/i);
  const replyMatch = text.match(/(?:^|\n)REPLY\|([^\n]*)/i);
  const start = text.indexOf("#¥%");
  const end = text.indexOf("%¥#", start + 3);
  if (!scoreMatch || !replyMatch) throw new Error("AI 返回的评分或回复不完整");
  if ((start < 0 || end < 0) && /(?:ADD_|UPDATE_|DELETE_|SET_TASK|EXCLUDE_INSTANCE|CLEAR|UNDO|WINDOW)\|?/i.test(text)) {
    throw new Error("AI 返回的规则边界不完整");
  }
  if (start < 0 || end < 0) return {
    score: Math.max(-1000, Math.min(100, Number(scoreMatch[1]))),
    scoreReason: scoreMatch[2]?.trim() || "日历 AI 自动评估",
    reply: replyMatch[1].trim(), operations: [], rawProtocol: text,
  };
  const operations = [];
  const body = text.slice(start + 3, end).trim();
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("//")) continue;
    const parts = line.split("|");
    const type = parts.shift()?.toUpperCase();
    if (type === "ADD_REPEAT" && parts.length >= 8) {
      const startTimes = parts[4].split(",").map((item) => item.trim()).filter(Boolean);
      operations.push({
        type: "add_repeat_task", title: parseField(parts[0]), location_group: parseField(parts[1]),
        period: parts[2] === "weekly" ? "weekly" : "daily",
        weekdays: parts[3] === "*" ? [] : parts[3].split(",").map(Number),
        start_time: startTimes[0], start_times: startTimes,
        start_date: parts[5], end_date: parts[6], course_id: parseField(parts[7]),
      });
    } else if (type === "ADD_SINGLE" && parts.length >= 6) {
      operations.push({
        type: "add_single_task", title: parseField(parts[0]), location_group: parseField(parts[1]),
        date: parts[2], start_time: parts[3], course_id: parseField(parts[4]), enabled: parts[5] !== "OFF",
      });
    } else if (type === "UPDATE_SINGLE" && parts.length >= 7) {
      operations.push({ type: "update_single_task", task_id: parseField(parts[0]), title: parseField(parts[1]), location_group: parseField(parts[2]), date: parts[3], start_time: parts[4], course_id: parseField(parts[5]), enabled: parts[6] !== "OFF" });
    } else if (type === "UPDATE_REPEAT" && parts.length >= 11) {
      const startTimes = parts[6].split(",").map((item) => item.trim()).filter(Boolean);
      operations.push({ type: "update_repeat_task", task_id: parseField(parts[0]), title: parseField(parts[1]), location_group: parseField(parts[2]), period: parts[3] === "weekly" ? "weekly" : "daily", weekdays: parts[4] === "*" ? [] : parts[4].split(",").map(Number), start_times: startTimes, start_time: startTimes[0], start_date: parts[7], end_date: parts[8], course_id: parseField(parts[9]), enabled: parts[10] !== "OFF" });
    } else if (type === "ADD_COURSE" && parts.length >= 3) operations.push({ type: "add_course", course_id: parseField(parts[0]), name: parseField(parts[1]), location_group: parseField(parts[2]) });
    else if (type === "UPDATE_COURSE" && parts.length >= 3) operations.push({ type: "update_course", course_id: parseField(parts[0]), name: parseField(parts[1]), location_group: parseField(parts[2]) });
    else if (type === "DELETE_COURSE" && parts[0]) operations.push({ type: "delete_course", course_id: parseField(parts[0]) });
    else if (type === "ADD_LOCATION" && parts.length >= 4) operations.push({ type: "add_location", name: parseField(parts[0]), lat: Number(parts[1]), lng: Number(parts[2]), acc: Number(parts[3]) });
    else if (type === "UPDATE_LOCATION" && parts.length >= 5) operations.push({ type: "update_location", old_name: parseField(parts[0]), name: parseField(parts[1]), lat: Number(parts[2]), lng: Number(parts[3]), acc: Number(parts[4]) });
    else if (type === "DELETE_LOCATION" && parts[0]) operations.push({ type: "delete_location", name: parseField(parts[0]) });
    else if ((type === "DELETE_TASK" || type === "DELETE") && parts[0]) operations.push({ type: "delete_task", task_id: parseField(parts[0]) });
    else if (type === "SET_TASK" && parts.length >= 2) operations.push({ type: "set_task_enabled", task_id: parseField(parts[0]), enabled: parts[1] !== "OFF" });
    else if (type === "EXCLUDE_INSTANCE" && parts.length >= 3) operations.push({ type: "exclude_repeat_instance", task_id: parseField(parts[0]), date: parts[1], occurrence_index: Number(parts[2]) });
    else if (type === "CLEAR_TASKS" || type === "CLEAR") operations.push({ type: "clear_tasks" });
    else if (type === "CLEAR_USER") operations.push({ type: "clear_user_calendar" });
    else if (type === "CLEAR_ALL") operations.push({ type: "clear_all_calendar" });
    else if (type === "UNDO") operations.push({ type: "undo_calendar" });
    else if (type === "WINDOW" && parts[0]) operations.push({ type: "update_window_minutes", window_minutes: Number(parts[0]) });
    else if (!['ASK', 'NONE', 'ZERO'].includes(type)) throw new Error(`无法识别规则：${line}`);
  }
  return {
    score: Math.max(-1000, Math.min(100, Number(scoreMatch[1]))),
    scoreReason: scoreMatch[2]?.trim() || "日历 AI 自动评估",
    reply: replyMatch?.[1]?.trim() || "规则已生成，请查看确认清单。",
    operations,
    rawProtocol: text,
  };
}

export function operationsToProtocol(operations, score, reason, reply) {
  const lines = [`SCORE|${score}|${reason}`, `REPLY|${String(reply ?? "").replace(/[\r\n|]+/g, " ")}`, "#¥%"];
  for (const operation of operations ?? []) {
    if (operation.type === "add_repeat_task") {
      lines.push([
        "ADD_REPEAT", field(operation.title), field(operation.location_group), operation.period,
        operation.period === "weekly" ? (operation.weekdays ?? [operation.weekday]).join(",") : "*",
        (operation.start_times?.length ? operation.start_times : [operation.start_time]).join(","), operation.start_date, operation.end_date, field(operation.course_id),
      ].join("|"));
    } else if (operation.type === "add_single_task") {
      lines.push(["ADD_SINGLE", field(operation.title), field(operation.location_group), operation.date, operation.start_time, field(operation.course_id), operation.enabled === false ? "OFF" : "ON"].join("|"));
    } else if (operation.type === "update_single_task") {
      lines.push(["UPDATE_SINGLE", field(operation.task_id), field(operation.title), field(operation.location_group), operation.date, operation.start_time, field(operation.course_id), operation.enabled === false ? "OFF" : "ON"].join("|"));
    } else if (operation.type === "update_repeat_task") {
      lines.push(["UPDATE_REPEAT", field(operation.task_id), field(operation.title), field(operation.location_group), operation.period, operation.period === "weekly" ? (operation.weekdays ?? []).join(",") : "*", (operation.start_times ?? [operation.start_time]).join(","), operation.start_date, operation.end_date, field(operation.course_id), operation.enabled === false ? "OFF" : "ON"].join("|"));
    } else if (operation.type === "add_course") lines.push(`ADD_COURSE|${field(operation.course_id)}|${field(operation.name)}|${field(operation.location_group)}`);
    else if (operation.type === "update_course") lines.push(`UPDATE_COURSE|${field(operation.course_id)}|${field(operation.name)}|${field(operation.location_group)}`);
    else if (operation.type === "delete_course") lines.push(`DELETE_COURSE|${field(operation.course_id)}`);
    else if (operation.type === "add_location") lines.push(`ADD_LOCATION|${field(operation.name)}|${operation.lat}|${operation.lng}|${operation.acc ?? 20}`);
    else if (operation.type === "update_location") lines.push(`UPDATE_LOCATION|${field(operation.old_name)}|${field(operation.name)}|${operation.lat}|${operation.lng}|${operation.acc ?? 20}`);
    else if (operation.type === "delete_location") lines.push(`DELETE_LOCATION|${field(operation.name)}`);
    else if (operation.type === "delete_task") lines.push(`DELETE_TASK|${field(operation.task_id)}`);
    else if (operation.type === "set_task_enabled") lines.push(`SET_TASK|${field(operation.task_id)}|${operation.enabled ? "ON" : "OFF"}`);
    else if (operation.type === "exclude_repeat_instance") lines.push(`EXCLUDE_INSTANCE|${field(operation.task_id)}|${operation.date}|${operation.occurrence_index}`);
    else if (operation.type === "clear_tasks") lines.push("CLEAR_TASKS");
    else if (operation.type === "clear_user_calendar") lines.push("CLEAR_USER");
    else if (operation.type === "clear_all_calendar") lines.push("CLEAR_ALL");
    else if (operation.type === "undo_calendar") lines.push("UNDO");
    else if (operation.type === "update_window_minutes") lines.push(`WINDOW|${operation.window_minutes}`);
  }
  if (!(operations ?? []).length) lines.push("NONE");
  lines.push("%¥#");
  return lines.join("\n");
}

export function humanizeOperations(operations) {
  const weekday = { 1: "一", 2: "二", 3: "三", 4: "四", 5: "五", 6: "六", 7: "日" };
  return (operations ?? []).map((operation) => {
    if (operation.type === "add_repeat_task") {
      const days = operation.period === "weekly" ? `每周${(operation.weekdays ?? [operation.weekday]).map((day) => weekday[day] ?? day).join("、")}` : "每天";
      const times = operation.start_times?.length ? operation.start_times.join("、") : operation.start_time;
      return `${days} ${times} · ${operation.location_group} · ${operation.title}`;
    }
    if (operation.type === "add_single_task") return `${operation.date} ${operation.start_time} · ${operation.location_group} · ${operation.title}`;
    if (operation.type === "update_single_task") return `修改单次任务 ${operation.task_id} → ${operation.date} ${operation.start_time} · ${operation.location_group}`;
    if (operation.type === "update_repeat_task") return `修改重复任务 ${operation.task_id} → ${(operation.start_times ?? [operation.start_time]).join("、")} · ${operation.location_group}`;
    if (operation.type === "add_course") return `新增课程 ${operation.name} · ${operation.location_group}`;
    if (operation.type === "update_course") return `修改课程 ${operation.course_id} → ${operation.name} · ${operation.location_group}`;
    if (operation.type === "delete_course") return `删除课程 ${operation.course_id}`;
    if (operation.type === "add_location") return `新增坐标组 ${operation.name} · ${operation.lat}, ${operation.lng}`;
    if (operation.type === "update_location") return `修改坐标组 ${operation.old_name} → ${operation.name}`;
    if (operation.type === "delete_location") return `删除坐标组 ${operation.name}`;
    if (operation.type === "delete_task") return `删除任务 ${operation.task_id}`;
    if (operation.type === "set_task_enabled") return `${operation.enabled ? "启用" : "停用"}任务 ${operation.task_id}`;
    if (operation.type === "exclude_repeat_instance") return `跳过 ${operation.date} 的重复任务 ${operation.task_id}`;
    if (operation.type === "clear_tasks") return "清空当前用户的单次任务和重复任务（保留课程与坐标）";
    if (operation.type === "clear_user_calendar") return "清空当前用户的课程与全部任务（保留坐标）";
    if (operation.type === "clear_all_calendar") return "清空当前账户的坐标、课程与全部任务";
    if (operation.type === "undo_calendar") return "恢复到上一次保存前的日历";
    if (operation.type === "update_window_minutes") return `签到时间窗口改为 ${operation.window_minutes} 分钟`;
    return "未知规则";
  });
}
