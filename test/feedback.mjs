import assert from "node:assert/strict";
import { submitFeedback } from "../src/feedback.js";

const writes = [];
const env = {
  DB: {
    prepare(sql) {
      return {
        bind(...values) {
          return { run: async () => writes.push({ sql, values }) };
        },
      };
    },
  },
};

await assert.rejects(
  submitFeedback(env, "account", { category: "bug", subject: "x", content: "内容足够长" }),
  /标题需要包含/,
);
await assert.rejects(
  submitFeedback(env, "account", { category: "invalid", subject: "有效标题", content: "内容足够长" }),
  /反馈分类无效/,
);
await submitFeedback(env, "account", { category: "suggestion", subject: "增加反馈", content: "希望管理员可以看到这条反馈。" });
assert.equal(writes.length, 1);
assert.equal(writes[0].values[1], "account");
assert.equal(writes[0].values[2], "suggestion");
console.log("feedback validation suite passed");
