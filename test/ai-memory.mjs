import assert from "node:assert/strict";
import { buildAiMemory, customMemoryText, normalizeLegacyCourseIds } from "../src/ai-chat.js";

const requirements = {
  normalized: { college: "理学院", locations: { E13: "讲座" }, courses: { math: "高数" } },
  locations: ["E13"], courses: [{ id: "math", name: "高等数学" }],
};
const content = buildAiMemory(requirements, "# 其他长期记忆\n只保留这一行");
assert.match(content, /学院：理学院/);
assert.match(content, /E13：讲座/);
assert.equal(customMemoryText(content), "# 其他长期记忆\n只保留这一行");

const legacyCalendar = {
  users: [{
    username: "测试用户",
    courses: [
      { name: "大学英语", location_group: "E13" },
      { name: "体育", location_group: "操场" },
      { id: "", name: "生物化学", location_group: "实验楼" },
      { id: "stable-course", name: "医学遗传学", location_group: "E13" },
      { id: "stable-course", name: "生理学", location_group: "E13" },
    ],
  }],
};
assert.equal(normalizeLegacyCourseIds(legacyCalendar, "测试用户"), true);
assert.deepEqual(
  legacyCalendar.users[0].courses.map((course) => course.id),
  ["legacy-course-1", "legacy-course-2", "legacy-course-3", "stable-course", "legacy-course-5"],
);
assert.equal(normalizeLegacyCourseIds(legacyCalendar, "测试用户"), false);
console.log("AI memory ownership suite passed");
