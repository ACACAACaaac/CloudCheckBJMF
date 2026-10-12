import assert from "node:assert/strict";
import { nextReadTarget } from "../src/scheduler.js";

const calendar = { users: [] };
const active = {
  enabled: true,
  attendanceEnabled: true,
  polling: { everyMinutes: 5, windows: [{ start: "06:00", end: "23:00" }] },
};

assert.equal(await nextReadTarget("account", { ...active, enabled: false }, calendar), null);
assert.equal(await nextReadTarget("account", { ...active, attendanceEnabled: false }, calendar), null);
assert.ok(await nextReadTarget("account", active, calendar), "running account needs a future target");
const pathologicalCalendar = {
  users: [{ username: "student", window_minutes: 100000, single_tasks: [], repeat_tasks: Array.from({ length: 1_000 }, (_, index) => ({
    id: `task-${index}`, enabled: true, period: "daily", start_date: "2020-01-01", end_date: "2030-01-01",
    occurrences: Array.from({ length: 1_000 }, () => ({ start_time: "08:00" })),
  })) }],
};
const started = Date.now();
await nextReadTarget("account", { ...active, username: "student" }, pathologicalCalendar);
assert.ok(Date.now() - started < 500, "scheduler must cap hostile calendar work");
console.log("scheduler safety suite passed");
