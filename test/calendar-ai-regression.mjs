import assert from "node:assert/strict";
import { applyCalendarOperations, deterministicCalendarFallback } from "../src/ai-chat.js";
import { operationsToProtocol, parseAiRuleProtocol } from "../src/calendar-rules.js";

const base = {
  version: 1,
  locations: [
    { name: "E13", location: { lat: 30.335114, lng: 120.037703, acc: 20 } },
    { name: "宿舍", location: { lat: 30.337415, lng: 120.036849, acc: 20 } },
  ],
  users: [{ username: "qa", classes: ["140562"], window_minutes: 20, courses: [], single_tasks: [], repeat_tasks: [] }],
};

const locations = base.locations;
for (const phrase of ["请删除所有签到", "清空全部打卡任务", "取消所有任务", "移除全部签到", "清除日历"]) {
  const result = deterministicCalendarFallback(phrase, locations);
  assert.ok(result, phrase);
  assert.equal(result.score, 100, phrase);
  assert.equal(result.operations[0].type, "clear_tasks", phrase);
}

const multi = deterministicCalendarFallback("每日8:00和13:00在E13签到", locations);
assert.deepEqual(multi.operations[0].start_times, ["08:00", "13:00"]);
const weekly = deterministicCalendarFallback("每周2，4，6 8:00和13:00在E13签到", locations);
assert.deepEqual(weekly.operations[0].weekdays, [2, 4, 6]);
const contextual = deterministicCalendarFallback("请生成一个每日8:00签到讲座的日历", locations, null, {
  E13: "E13 常常发生讲座", 宿舍: "宿舍常常发生晚归打卡",
});
assert.equal(contextual.operations[0].location_group, "E13");
const ambiguous = deterministicCalendarFallback("请生成一个每日8:00签到讲座的日历", locations, null, {
  E13: "E13 常常发生讲座", 宿舍: "宿舍也会发生讲座",
});
assert.equal(ambiguous.operations.length, 0);
assert.match(ambiguous.reply, /多个坐标组/);

const courseRequest = deterministicCalendarFallback("请新增一门名为高等数学、地点为E13的课程", locations);
assert.equal(courseRequest.operations[0].type, "add_course");
assert.equal(courseRequest.operations[0].name, "高等数学");
const windowRequest = deterministicCalendarFallback("请把签到窗口改成30分钟", locations);
assert.deepEqual(windowRequest.operations, [{ type: "update_window_minutes", window_minutes: 30 }]);

const protocol = operationsToProtocol(multi.operations, 100, "正常请求", multi.reply);
assert.deepEqual(parseAiRuleProtocol(protocol).operations[0].start_times, ["08:00", "13:00"]);

const created = applyCalendarOperations(base, "qa", [
  { type: "add_course", course_id: "math", name: "高等数学", location_group: "E13" },
  { type: "add_single_task", title: "临时签到", location_group: "宿舍", date: "2026-09-01", start_time: "09:00", course_id: "", enabled: true },
  { ...weekly.operations[0], course_id: "math", title: "高等数学" },
  { type: "update_window_minutes", window_minutes: 30 },
]);
const user = created.users[0];
assert.equal(user.courses.length, 1);
assert.equal(user.single_tasks.length, 1);
assert.equal(user.repeat_tasks[0].occurrences.length, 6);
assert.equal(user.window_minutes, 30);

const edited = applyCalendarOperations(created, "qa", [
  { type: "set_task_enabled", task_id: user.repeat_tasks[0].id, enabled: false },
  { type: "exclude_repeat_instance", task_id: user.repeat_tasks[0].id, date: "2026-09-01", occurrence_index: 0 },
  { type: "update_single_task", task_id: user.single_tasks[0].id, title: "改期签到", location_group: "E13", date: "2026-09-02", start_time: "10:00", course_id: "", enabled: true },
]);
assert.equal(edited.users[0].repeat_tasks[0].enabled, false);
assert.deepEqual(edited.users[0].repeat_tasks[0].excluded_instances, ["2026-09-01#0"]);
assert.equal(edited.users[0].single_tasks[0].start_time, "10:00");

const cleared = applyCalendarOperations(edited, "qa", [{ type: "clear_tasks" }]);
assert.equal(cleared.users[0].single_tasks.length, 0);
assert.equal(cleared.users[0].repeat_tasks.length, 0);
assert.equal(cleared.users[0].courses.length, 1);
const disabled = deterministicCalendarFallback("请停用当前所有签到任务", locations, edited.users[0]);
assert.equal(disabled.operations.length, 2);
assert.ok(disabled.operations.every((operation) => operation.type === "set_task_enabled" && operation.enabled === false));

const updated = deterministicCalendarFallback("请把每天08:00和13:00在E13的签到任务改成每天09:00和14:00", locations, created.users[0]);
assert.equal(updated.operations[0].type, "update_repeat_task");
assert.deepEqual(updated.operations[0].start_times, ["09:00", "14:00"]);
const deleted = deterministicCalendarFallback("请删除每天08:00和13:00在E13的签到任务", locations, created.users[0]);
assert.equal(deleted.operations[0].type, "delete_task");
const read = deterministicCalendarFallback("请读取我的日历并说明目前有哪些签到任务，不要修改", locations, created.users[0]);
assert.equal(read.operations.length, 0);
assert.match(read.reply, /08:00、13:00/);
console.log("calendar AI regression suite passed");
