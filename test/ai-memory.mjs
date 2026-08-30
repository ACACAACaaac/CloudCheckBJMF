import assert from "node:assert/strict";
import { buildAiMemory, customMemoryText } from "../src/ai-chat.js";

const requirements = {
  normalized: { college: "理学院", locations: { E13: "讲座" }, courses: { math: "高数" } },
  locations: ["E13"], courses: [{ id: "math", name: "高等数学" }],
};
const content = buildAiMemory(requirements, "# 其他长期记忆\n只保留这一行");
assert.match(content, /学院：理学院/);
assert.match(content, /E13：讲座/);
assert.equal(customMemoryText(content), "# 其他长期记忆\n只保留这一行");
console.log("AI memory ownership suite passed");
