import { describe, expect, it } from "vitest";
import { classifyGatewayStorageFailure } from "../../infra/sqlite-error-diagnostics.js";
import { formatUserFacingAssistantErrorText } from "../embedded-agent-helpers/error-text.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { renderAssistantRequestFailureCopy } from "./assistant-request-failure-copy.js";

describe("renderAssistantRequestFailureCopy", () => {
  const target = { provider: "openai", model: "test-model" };
  const runFailure = "⚠️ Agent run failed (model: openai/test-model).";

  it.each([
    [{ errcode: 261 }, "SQLITE_BUSY"],
    [{ errcode: 13, message: "database is locked" }, "SQLITE_FULL"],
    [{ errstr: "attempt to write a readonly database" }, "SQLITE_READONLY"],
    [{ errorCode: "SQLITE_IOERR_WRITE", errorMessage: "PRIVATE_CANARY" }, "SQLITE_IOERR"],
    [{ code: "SQLITE_LOCKED_SHAREDCACHE" }, "SQLITE_LOCKED"],
    [
      { errorMessage: "session writer claim changed before transcript persistence" },
      "transcript_writer_fenced",
    ],
  ] as const)("classifies storage facts %j", (error, expected) => {
    expect(classifyGatewayStorageFailure(error)).toBe(expected);
    expect(
      renderAssistantRequestFailureCopy({ storageFailure: classifyGatewayStorageFailure(error) }),
    ).not.toContain("PRIVATE_CANARY");
  });

  it.each([
    ["database is locked", "was busy", "Retry; if it repeats, check Gateway storage health."],
    ["database or disk is full", "was full", "Free disk space on the Gateway host and retry."],
    [
      "attempt to write a readonly database",
      "was read-only",
      "Check Gateway storage permissions and retry.",
    ],
    [
      "disk I/O error",
      "had an I/O error",
      "Check Gateway storage health and filesystem access before retrying.",
    ],
  ])(
    "names the internal storage failure %s without provider attribution",
    (errorMessage, detail, nextStep) => {
      expect(
        formatUserFacingAssistantErrorText(
          makeAssistantMessageFixture({ ...target, errorMessage }),
        ),
      ).toBe(
        `⚠️ Agent run failed: the Gateway state database ${detail} (SQLite: ${errorMessage}). ${nextStep}`,
      );
    },
  );

  it("preserves an incomplete tool-call diagnosis without exposing provider text", () => {
    const error = makeAssistantMessageFixture({
      ...target,
      errorCode: "incomplete_tool_call",
      errorMessage: "PRIVATE_PROVIDER_DETAIL",
    });
    expect(formatUserFacingAssistantErrorText(error)).toBe(
      "⚠️ The provider returned an unfinished tool call. Earlier actions may have completed; verify their results before continuing.",
    );
  });

  it("keeps provider bodies containing SQLite text redacted", () => {
    const errorMessage = '{"error":{"message":"database is locked PRIVATE_CANARY"}}';
    expect(
      formatUserFacingAssistantErrorText(makeAssistantMessageFixture({ ...target, errorMessage })),
    ).toBe(runFailure);
  });

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
