const MAX_IMPORT_CHARS = 180_000;
const DAY_NAMES = new Map([
  ["一", 1], ["二", 2], ["三", 3], ["四", 4], ["五", 5], ["六", 6], ["日", 7], ["天", 7],
]);

function clean(value, limit = 300) {
  return String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""));
}

function validTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value ?? ""));
}

function normalizeTime(value) {
  const match = clean(value).match(/(?:^|\D)([0-2]?\d)[:：]([0-5]\d)(?:\D|$)/);
  if (!match) return "";
  const hour = Number(match[1]);
  return hour <= 23 ? `${String(hour).padStart(2, "0")}:${match[2]}` : "";
}

export function parseWeekdays(value) {
  const text = clean(value).replace(/星期/g, "周");
  const result = new Set();
  for (const match of text.matchAll(/周([一二三四五六日天1-7])/g)) {
    const day = DAY_NAMES.get(match[1]) ?? Number(match[1]);
    if (day >= 1 && day <= 7) result.add(day);
  }
  return [...result].sort((left, right) => left - right);
}

function defaultTerm(value = {}) {
  const startDate = validDate(value.startDate) ? value.startDate : "";
  const endDate = validDate(value.endDate) ? value.endDate : "";
  return { startDate, endDate };
}

function rowItem(row, term, index) {
  const title = clean(row.title ?? row.course ?? row.name, 120);
  const weekdays = Array.isArray(row.weekdays) ? row.weekdays.map(Number).filter((day) => day >= 1 && day <= 7) : parseWeekdays(row.weekdays ?? row.weekday);
  const startTime = normalizeTime(row.startTime ?? row.start_time ?? row.time);
  const locationHint = clean(row.locationHint ?? row.location ?? row.room ?? row.classroom, 120);
  const startDate = validDate(row.startDate ?? row.start_date) ? row.startDate ?? row.start_date : term.startDate;
  const endDate = validDate(row.endDate ?? row.end_date) ? row.endDate ?? row.end_date : term.endDate;
  const warnings = [];
  if (!title) warnings.push("缺少课程名称");
  if (!weekdays.length) warnings.push("未识别星期");
  if (!startTime) warnings.push("未识别开始时间");
  if (!startDate || !endDate) warnings.push("请填写学期起止日期");
  if (startDate && endDate && startDate > endDate) warnings.push("开始日期晚于结束日期");
  return {
    id: `draft-${index + 1}`,
    title: title || `未命名课程 ${index + 1}`,
    weekdays,
    startTime,
    locationHint,
    startDate,
    endDate,
    warnings,
  };
}

function splitCsvLine(line) {
  const values = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"') { value += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { values.push(value.trim()); value = ""; }
    else value += char;
  }
  values.push(value.trim());
  return values;
}

function csvKey(value) {
  const key = clean(value).toLowerCase().replace(/[ _-]/g, "");
  if (["课程", "课程名", "课程名称", "course", "coursename", "name", "title"].includes(key)) return "title";
  if (["星期", "周几", "weekday", "weekdays", "day"].includes(key)) return "weekdays";
  if (["开始时间", "时间", "starttime", "time"].includes(key)) return "startTime";
  if (["地点", "教室", "location", "room", "classroom"].includes(key)) return "locationHint";
  if (["开始日期", "开学日期", "startdate"].includes(key)) return "startDate";
  if (["结束日期", "截止日期", "enddate"].includes(key)) return "endDate";
  return "";
}

function parseCsv(text, term) {
  const lines = String(text).replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return { rows: [], warnings: ["CSV 至少需要表头和一条课程记录"] };
  const keys = splitCsvLine(lines[0]).map(csvKey);
  if (!keys.includes("title")) return { rows: [], warnings: ["CSV 表头需要包含“课程名”或 course"] };
  const rows = lines.slice(1).map((line, index) => {
    const cells = splitCsvLine(line);
    const row = {};
    keys.forEach((key, cellIndex) => { if (key) row[key] = cells[cellIndex] ?? ""; });
    return rowItem(row, term, index);
  });
  return { rows, warnings: [] };
}

function htmlToText(value) {
  return String(value)
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(?:tr|p|div|li|br|td|th)>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(?:x)?[0-9a-f]+;/gi, " ");
}

function parseLooseText(text, term) {
  const rows = [];
  for (const line of String(text).split(/\r?\n|[；;]/).map((item) => clean(item)).filter(Boolean)) {
    const parts = line.split(/[|｜]/).map((item) => clean(item)).filter(Boolean);
    const weekdayText = parts.find((part) => parseWeekdays(part).length) ?? line;
    const timeText = parts.find((part) => normalizeTime(part)) ?? line;
    const weekdays = parseWeekdays(weekdayText);
    const startTime = normalizeTime(timeText);
    if (!weekdays.length && !startTime) continue;
    const title = parts[0] && !parseWeekdays(parts[0]).length && !normalizeTime(parts[0]) ? parts[0] : "";
    const candidates = parts.filter((part) => part !== title && !parseWeekdays(part).length && !normalizeTime(part) && !validDate(part));
    rows.push(rowItem({ title, weekdays, startTime, locationHint: candidates[0] ?? "" }, term, rows.length));
  }
  return { rows, warnings: rows.length ? [] : ["没有识别到课程。建议使用“课程名｜周一、周三｜08:00｜地点”的格式，或上传 CSV。"] };
}

function parseIcs(text, term) {
  const rows = [];
  const events = String(text).split("BEGIN:VEVENT").slice(1);
  for (const event of events) {
    const summary = event.match(/\nSUMMARY:(.+)/)?.[1] ?? "";
    const start = event.match(/\nDTSTART(?:;[^:]*)?:(\d{8})T?(\d{4,6})?/) ?? [];
    const recurrence = event.match(/\nRRULE:(.+)/)?.[1] ?? "";
    const byDay = recurrence.match(/BYDAY=([^;]+)/)?.[1] ?? "";
    const dayMap = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 };
    const weekdays = byDay.split(",").map((day) => dayMap[day]).filter(Boolean);
    const date = start[1] ? `${start[1].slice(0, 4)}-${start[1].slice(4, 6)}-${start[1].slice(6, 8)}` : "";
    const startTime = start[2] ? `${start[2].slice(0, 2)}:${start[2].slice(2, 4)}` : "";
    rows.push(rowItem({ title: summary, weekdays, startTime, startDate: date || term.startDate, endDate: term.endDate }, term, rows.length));
  }
  return { rows, warnings: rows.length ? [] : ["ICS 中没有找到可导入的重复课程事件"] };
}

export function parseCalendarImport(value = {}) {
  const source = ["text", "csv", "html", "ics"].includes(value.source) ? value.source : "text";
  const text = String(value.text ?? "");
  if (!text.trim()) throw new Error("请先粘贴内容或选择文件");
  if (text.length > MAX_IMPORT_CHARS) throw new Error("导入内容过大，请控制在 180000 个字符以内");
  const term = defaultTerm(value.term);
  const parsed = source === "csv" ? parseCsv(text, term)
    : source === "html" ? parseLooseText(htmlToText(text), term)
      : source === "ics" ? parseIcs(text, term)
        : parseLooseText(text, term);
  return {
    source,
    items: parsed.rows.slice(0, 300),
    warnings: parsed.warnings,
    term,
  };
}

function importUsername(account, calendar) {
  const candidates = [account.login_name, account.display_name].filter(Boolean);
  return candidates.find((name) => (calendar.users ?? []).some((user) => user.username === name)) ?? candidates[0] ?? "当前用户";
}

function makeId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function validItem(item) {
  return item && clean(item.title, 120) && Array.isArray(item.weekdays) && item.weekdays.length
    && validTime(item.startTime) && validDate(item.startDate) && validDate(item.endDate)
    && item.startDate <= item.endDate && clean(item.locationGroup, 120);
}

export function appendImportedCalendar(calendar, account, rawItems = []) {
  const document = structuredClone(calendar && typeof calendar === "object" ? calendar : { version: 1, locations: [], users: [] });
  document.version = 1;
  document.locations = Array.isArray(document.locations) ? document.locations : [];
  document.users = Array.isArray(document.users) ? document.users : [];
  const username = importUsername(account, document);
  let user = document.users.find((entry) => entry.username === username);
  if (!user) {
    user = { username, classes: [], window_minutes: 20, courses: [], single_tasks: [], repeat_tasks: [] };
    document.users.push(user);
  }
  user.courses = Array.isArray(user.courses) ? user.courses : [];
  user.single_tasks = Array.isArray(user.single_tasks) ? user.single_tasks : [];
  user.repeat_tasks = Array.isArray(user.repeat_tasks) ? user.repeat_tasks : [];
  const locationNames = new Set(document.locations.map((location) => clean(location.name, 120)));
  const created = [];
  const skipped = [];
  for (const [index, source] of rawItems.entries()) {
    const item = {
      title: clean(source?.title, 120), weekdays: [...new Set((source?.weekdays ?? []).map(Number).filter((day) => day >= 1 && day <= 7))],
      startTime: clean(source?.startTime, 5), startDate: clean(source?.startDate, 10), endDate: clean(source?.endDate, 10),
      locationGroup: clean(source?.locationGroup, 120),
    };
    if (!validItem(item) || !locationNames.has(item.locationGroup)) {
      skipped.push({ index, title: item.title || `第 ${index + 1} 项`, reason: "信息不完整或坐标组不存在" });
      continue;
    }
    const duplicate = user.repeat_tasks.some((task) => task.title === item.title
      && task.location_group === item.locationGroup && task.start_date === item.startDate && task.end_date === item.endDate
      && JSON.stringify(task.occurrences ?? []) === JSON.stringify(item.weekdays.map((weekday) => ({ weekday, start_time: item.startTime }))));
    if (duplicate) {
      skipped.push({ index, title: item.title, reason: "已有完全相同的重复任务" });
      continue;
    }
    let course = user.courses.find((entry) => entry.name === item.title && entry.location_group === item.locationGroup);
    if (!course) {
      course = { id: makeId("course"), name: item.title, location_group: item.locationGroup };
      user.courses.push(course);
    }
    user.repeat_tasks.push({
      id: makeId("repeat"), title: item.title, location_group: item.locationGroup, course_id: course.id,
      period: "weekly", occurrences: item.weekdays.map((weekday) => ({ weekday, start_time: item.startTime })),
      start_date: item.startDate, end_date: item.endDate, enabled: true, excluded_instances: [], import_source: "calendar-import",
    });
    created.push(item.title);
  }
  return { document, created, skipped };
}
