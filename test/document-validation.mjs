import assert from "node:assert/strict";
import { validateDocument } from "../src/documents.js";

const settings = {
  enabled: true, attendanceEnabled: true, username: "student",
  classes: ["140562"], excludedClasses: [], calendarWindowMinutes: 20,
  polling: { everyMinutes: 5, windows: [{ start: "06:00", end: "23:00" }], locationGroup: "E13" },
};
assert.doesNotThrow(() => validateDocument(settings, "settings"));
assert.throws(() => validateDocument({ ...settings, classes: ["<button>bad</button>"] }, "settings"), /班级号/);
assert.throws(() => validateDocument({ ...settings, polling: { ...settings.polling, everyMinutes: 0 } }, "settings"), /轮询间隔/);

const calendar = {
  version: 1,
  locations: [{ name: "E13", location: { lat: 30.335114, lng: 120.037703, acc: 20 } }],
  users: [{ username: "student", window_minutes: 20, courses: [], single_tasks: [], repeat_tasks: [] }],
};
assert.doesNotThrow(() => validateDocument(calendar, "calendar"));
assert.throws(() => validateDocument({ ...calendar, locations: [{ name: "<img>", location: { lat: 0, lng: 0, acc: 20 } }] }, "calendar"), /坐标组名称/);
assert.throws(() => validateDocument({ ...calendar, users: [{ ...calendar.users[0], window_minutes: 100000 }] }, "calendar"), /签到窗口/);
console.log("document validation suite passed");
