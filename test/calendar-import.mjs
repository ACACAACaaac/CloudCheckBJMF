import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { appendImportedCalendar, parseCalendarImport } from "../src/calendar-import.js";

const parsed = parseCalendarImport({
  source: "text", term: { startDate: "2026-09-14", endDate: "2027-01-15" },
  text: "大学英语｜周一、周三｜08:00｜E13\n高等数学｜周二｜10:00｜B201",
});
assert.equal(parsed.items.length, 2);
assert.deepEqual(parsed.items[0].weekdays, [1, 3]);
assert.equal(parsed.items[0].startTime, "08:00");

const csv = parseCalendarImport({
  source: "csv", term: { startDate: "2026-09-14", endDate: "2027-01-15" },
  text: "课程名,星期,开始时间,地点\n大学物理,周二、周四,13:00,E13",
});
assert.equal(csv.items.length, 1);
assert.deepEqual(csv.items[0].weekdays, [2, 4]);
assert.equal(csv.items[0].locationHint, "E13");

const book = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
  ["课程名", "星期", "开始时间", "地点"], ["大学化学", "周一", "09:00", "E13"],
]), "课表");
const excel = parseCalendarImport({
  source: "xlsx", term: { startDate: "2026-09-14", endDate: "2027-01-15" },
  binary: XLSX.write(book, { type: "base64", bookType: "xlsx" }),
});
assert.equal(excel.items.length, 1);
assert.equal(excel.items[0].title, "大学化学");

const html = parseCalendarImport({
  source: "html", term: { startDate: "2026-09-14", endDate: "2027-01-15" },
  text: "<table><tr><td>线性代数｜周五｜15:00｜B201</td></tr></table>",
});
assert.equal(html.items.length, 1);
assert.equal(html.items[0].title, "线性代数");

const htmlTable = parseCalendarImport({
  source: "html", term: { startDate: "2026-09-14", endDate: "2027-01-15" },
  text: "<table><tr><th>节次</th><th>周一</th><th>周二</th></tr><tr><td>08:00</td><td>高等数学</td><td>大学英语</td></tr></table>",
});
assert.equal(htmlTable.items.length, 2);
assert.equal(htmlTable.items[0].startTime, "08:00");

const ics = parseCalendarImport({
  source: "ics", term: { startDate: "2026-09-14", endDate: "2027-01-15" },
  text: "BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:程序设计\nDTSTART:20260914T080000\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE\nEND:VEVENT\nEND:VCALENDAR",
});
assert.equal(ics.items.length, 1);
assert.deepEqual(ics.items[0].weekdays, [1, 3]);

const initial = { version: 1, locations: [{ name: "E13" }, { name: "B201" }], users: [{ username: "alice", courses: [], single_tasks: [], repeat_tasks: [] }] };
const result = appendImportedCalendar(initial, { login_name: "alice" }, parsed.items.map((item) => ({ ...item, locationGroup: item.locationHint })));
assert.equal(result.created.length, 2);
assert.equal(initial.users[0].repeat_tasks.length, 0, "import must not mutate the source calendar");
assert.equal(result.document.users[0].repeat_tasks.length, 2);
const second = appendImportedCalendar(result.document, { login_name: "alice" }, parsed.items.map((item) => ({ ...item, locationGroup: item.locationHint })));
assert.equal(second.created.length, 0);
assert.equal(second.skipped.length, 2);
console.log("calendar import suite passed");
