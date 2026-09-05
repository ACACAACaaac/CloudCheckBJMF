import assert from "node:assert/strict";
import { feedbackImages, validateFeedbackImages, replyFeedback, submitFeedback } from "../src/feedback.js";

const writes = [];
const env = {
  DB: {
    prepare(sql) {
      return {
        bind(...values) {
          return { run: async () => { writes.push({ sql, values }); return { meta: { changes: 1 } }; } };
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
await assert.rejects(replyFeedback(env, "feedback", { reply: "" }), /回复内容需要包含/);
await replyFeedback(env, "feedback", { reply: "已收到，会处理。" });
assert.equal(writes.length, 2);
assert.equal(writes[1].values[0], "已收到，会处理。");
console.log("feedback validation suite passed");
assert.deepEqual(validateFeedbackImages(), []);
assert.throws(() => validateFeedbackImages(Array(4).fill("")), /最多/);
assert.throws(() => validateFeedbackImages(["data:image/svg+xml;base64,abcd"]), /格式/);
assert.throws(() => validateFeedbackImages(["data:image/jpeg;base64,/9j/" + "A".repeat(280000)]), /大小/);
const accessEnv = { DB: { prepare(sql) {
  assert.match(sql, /account_id=\? OR \?='admin'/);
  return { bind(id, accountId, role) { return { first: async () =>
    id === "feedback" && (accountId === "owner" || role === "admin") ? { images_json: '[]' } : null,
  }; } };
} } };
assert.equal(await feedbackImages(accessEnv, { id: "other", role: "user" }, "feedback"), null);
assert.deepEqual(await feedbackImages(accessEnv, { id: "owner", role: "user" }, "feedback"), []);
assert.deepEqual(await feedbackImages(accessEnv, { id: "other", role: "admin" }, "feedback"), []);
