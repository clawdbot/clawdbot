// Attempt-notification tests cover Codex app-server envelope parsing and diagnostics.
import { describe, expect, it } from "vitest";
import {
  describeNotificationActivity,
  isCodexTurnAbortMarkerNotification,
} from "./attempt-notifications.js";
import type { CodexServerNotification } from "./protocol.js";

function abortMarkerNotification(params: {
  role: "user" | "developer";
  text: string;
}): CodexServerNotification {
  return {
    method: "rawResponseItem/completed",
    params: {
      item: {
        id: "abort-marker-1",
        type: "message",
        role: params.role,
        content: [{ type: "input_text", text: params.text }],
      },
    },
  };
}

describe("describeNotificationActivity", () => {
  it("does not split surrogate pairs in assistant text previews", () => {
    const details = describeNotificationActivity({
      method: "rawResponseItem/completed",
      params: {
        item: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: `${"x".repeat(236)}🚀tail` }],
        },
      },
    });

    expect(details?.lastAssistantTextPreview).toBe(`${"x".repeat(236)}...`);
  });
});

describe("isCodexTurnAbortMarkerNotification", () => {
  it("accepts a wrapped user marker", () => {
    expect(
      isCodexTurnAbortMarkerNotification(
        abortMarkerNotification({
          role: "user",
          text: "<turn_aborted>\nuser interruption hint\n</turn_aborted>",
        }),
      ),
    ).toBe(true);
  });

  it("accepts a wrapped developer marker", () => {
    expect(
      isCodexTurnAbortMarkerNotification(
        abortMarkerNotification({
          role: "developer",
          text: "<turn_aborted>\ndeveloper interruption hint\n</turn_aborted>",
        }),
      ),
    ).toBe(true);
  });

  it("accepts arbitrary wrapped body prose", () => {
    expect(
      isCodexTurnAbortMarkerNotification(
        abortMarkerNotification({
          role: "user",
          text: "<turn_aborted>\nwording may change independently\n</turn_aborted>",
        }),
      ),
    ).toBe(true);
  });

  it("rejects a malformed wrapper", () => {
    expect(
      isCodexTurnAbortMarkerNotification(
        abortMarkerNotification({
          role: "user",
          text: "<turn_aborted>\nmissing closing tag",
        }),
      ),
    ).toBe(false);
  });

  it("rejects the current user prompt echoed through raw response events", () => {
    const currentPrompt = "<turn_aborted>\nliteral user prompt\n</turn_aborted>";
    expect(
      isCodexTurnAbortMarkerNotification(
        abortMarkerNotification({ role: "user", text: currentPrompt }),
        { currentPromptText: currentPrompt },
      ),
    ).toBe(false);
  });
});
