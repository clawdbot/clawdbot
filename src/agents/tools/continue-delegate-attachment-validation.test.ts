import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cancelPendingDelegates,
  consumePendingDelegates,
} from "../../auto-reply/continuation/delegate-store.js";
import { resetContinueDelegateTurnAdmissionForTests } from "../../auto-reply/continuation/delegate-turn-admission.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { InlineAttachment } from "../../shared/inline-attachments.js";
import { createContinueDelegateTool } from "./continue-delegate-tool.js";

async function captureToolError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return String(error);
  }
  throw new Error("expected tool call to fail");
}

function withSafeAttachment(attachment: InlineAttachment): InlineAttachment[] {
  return [{ name: "safe.txt", content: "12" }, attachment];
}

describe("continue_delegate attachment validation redaction", () => {
  beforeEach(() => {
    cancelPendingDelegates("test-session");
    consumePendingDelegates("test-session");
    resetContinueDelegateTurnAdmissionForTests();
    clearRuntimeConfigSnapshot();
  });

  afterEach(() => {
    cancelPendingDelegates("test-session");
    resetContinueDelegateTurnAdmissionForTests();
    clearRuntimeConfigSnapshot();
  });

  it.each([
    {
      label: "MIME whitespace",
      attachments: withSafeAttachment({
        name: "PRIVATE_MIME_NAME.txt",
        content: "34",
        mimeType: "PRIVATE_MIME_VALUE ",
      }),
      expected: "attachments_invalid_member (attachmentIndex=1 reason=mime_type_whitespace)",
    },
    {
      label: "oversized MIME",
      attachments: withSafeAttachment({
        name: "PRIVATE_OVERSIZED_MIME_NAME.txt",
        content: "34",
        mimeType: "m".repeat(257),
      }),
      expected:
        "attachments_invalid_member (attachmentIndex=1 reason=mime_type_too_long maxMimeTypeBytes=256)",
    },
    {
      label: "invalid Unicode content",
      attachments: withSafeAttachment({
        name: "PRIVATE_CONTENT_NAME.txt",
        content: "\uD800",
      }),
      expected: "attachments_invalid_content (attachmentIndex=1 reason=invalid_unicode)",
    },
  ])("returns a closed $label discriminator", async ({ attachments, expected }) => {
    setRuntimeConfigSnapshot({
      tools: {
        sessions_spawn: {
          attachments: { enabled: true, maxFileBytes: 4, maxTotalBytes: 6 },
        },
      },
    });
    const tool = createContinueDelegateTool({ agentSessionKey: "test-session" });
    const mountPath = "PRIVATE_MOUNT_DESTINATION";
    const pathSentinel = "/PRIVATE/ATTACHMENT/PATH/MUST_NOT_ECHO";
    const receiptSentinel = "PRIVATE_RECEIPT_ID_MUST_NOT_ECHO";
    const serialized = await captureToolError(
      tool.execute(`call-safe-discriminator-${expected}`, {
        task: `reject ${pathSentinel} ${receiptSentinel}`,
        attachments,
        attachAs: { mountPath },
      }),
    );

    expect(serialized).toContain(expected);
    for (const attachment of attachments) {
      expect(serialized).not.toContain(attachment.name);
      expect(serialized).not.toContain(attachment.content);
      if (attachment.mimeType) {
        expect(serialized).not.toContain(attachment.mimeType);
      }
    }
    for (const sensitiveValue of [mountPath, pathSentinel, receiptSentinel]) {
      expect(serialized).not.toContain(sensitiveValue);
    }
    expect(consumePendingDelegates("test-session")).toEqual([]);
  });

  it("returns a closed mount length reason without echoing the mount", async () => {
    const tool = createContinueDelegateTool({ agentSessionKey: "test-session" });
    const mountPath = "m".repeat(1025);
    const pathSentinel = "/PRIVATE/MOUNT/PATH/MUST_NOT_ECHO";
    const receiptSentinel = "PRIVATE_MOUNT_RECEIPT_MUST_NOT_ECHO";
    const serialized = await captureToolError(
      tool.execute("call-overlong-mount", {
        task: `reject ${pathSentinel} ${receiptSentinel}`,
        attachAs: { mountPath },
      }),
    );

    expect(serialized).toContain(
      "attachAs.mountPath invalid (reason=too_long maxMountPathBytes=1024)",
    );
    for (const sensitiveValue of [mountPath, pathSentinel, receiptSentinel]) {
      expect(serialized).not.toContain(sensitiveValue);
    }
    expect(consumePendingDelegates("test-session")).toEqual([]);
  });
});
