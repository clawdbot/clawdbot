import { describe, expect, it } from "vitest";
import { normalizeActiveSummary } from "./prompt.js";

describe("normalizeActiveSummary", () => {
  it.each([
    "Hello! How can I help you today?",
    "Hello! It seems like your message got cut off.",
    "It seems like your message got cut off. Could you provide more details?",
    "Please let me know if you need help.",
    "您好！请问有什么可以帮助您的吗？",
    "您好！看起来您的消息可能没有包含具体问题或请求。",
    "当前模型是 example/model。如果您需要帮助，请告诉我。",
  ])("rejects anchored assistant chitchat: %s", (summary) => {
    expect(normalizeActiveSummary(summary)).toBeNull();
  });

  it.each([
    "User's favorite food is ramen.",
    "Hello Kitty is the user's favorite character.",
    "Hello is the user's preferred project name.",
    "User prefers vendors that provide more details about their supply chain.",
    "用户偏好能提供更多详细信息的供应商。",
  ])("keeps grounded summary text that shares chitchat words: %s", (summary) => {
    expect(normalizeActiveSummary(summary)).toBe(summary);
  });
});
