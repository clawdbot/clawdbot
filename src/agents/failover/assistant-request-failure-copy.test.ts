import { describe, expect, it } from "vitest";
import { renderAssistantRequestFailureCopy } from "./assistant-request-failure-copy.js";

describe("renderAssistantRequestFailureCopy", () => {
  const target = { provider: "openai", model: "test-model" };
  const runFailure = "⚠️ Agent run failed (model: openai/test-model).";

  it.each([undefined, null, "unclassified", "unknown"] as const)(
    "keeps the model as context when reason is %s",
    (reason) => {
      expect(renderAssistantRequestFailureCopy({ ...target, reason })).toBe(runFailure);
    },
  );

  it.each(["empty_response", "no_error_details"] as const)(
    "retains provider attribution for the recognized %s terminal",
    (reason) => {
      expect(renderAssistantRequestFailureCopy({ ...target, reason })).toBe(
        "⚠️ openai/test-model request failed.",
      );
      expect(renderAssistantRequestFailureCopy({ reason })).toBeUndefined();
    },
  );

  it.each([
    [{ provider: "openai" }, "⚠️ Agent run failed (provider: openai)."],
    [{ model: "test-model" }, "⚠️ Agent run failed (model: test-model)."],
    [{}, undefined],
  ] as const)("handles partial model context %j", (facts, expected) => {
    expect(renderAssistantRequestFailureCopy(facts)).toBe(expected);
  });

  it("requires a valid HTTP status before asserting a request failure", () => {
    expect(renderAssistantRequestFailureCopy({ ...target, status: 0 })).toBe(runFailure);
    expect(renderAssistantRequestFailureCopy({ ...target, status: 400 })).toBe(
      "⚠️ openai/test-model request failed (HTTP 400).",
    );
  });

  it("retains classified guidance without an HTTP status", () => {
    expect(renderAssistantRequestFailureCopy({ ...target, reason: "auth" })).toBe(
      "⚠️ openai/test-model request failed (authentication failed). Re-authenticate the provider and try again.",
    );
  });
});
