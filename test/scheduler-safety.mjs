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
console.log("scheduler safety suite passed");
