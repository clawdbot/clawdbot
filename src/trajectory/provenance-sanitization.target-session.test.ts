import { describe, expect, it } from "vitest";
import {
  hashTrajectoryIdentifier,
  TRAJECTORY_SOURCE_SESSION_HASH_DOMAIN,
  TrajectoryProvenanceSanitizer,
} from "./provenance-sanitization.js";

type TestEvent = {
  source: string;
  type: string;
  data: Record<string, unknown>;
};

describe("trajectory target-session hash sanitization", () => {
  it("preserves only the canonical runtime tool-result field", () => {
    const targetSessionHash = hashTrajectoryIdentifier(
      TRAJECTORY_SOURCE_SESSION_HASH_DOMAIN,
      "agent:target:main",
    );
    const rawSessionKey = "opaque-session-credential-123456";
    const runtimeEvents: TestEvent[] = [
      {
        source: "runtime",
        type: "tool.result",
        data: {
          targetSessionHash,
          arguments: { targetSessionHash, sessionKey: rawSessionKey },
          result: {
            targetSessionHash,
            details: { targetSessionHash, sourceSessionKey: rawSessionKey },
          },
        },
      },
      {
        source: "runtime",
        type: "context.compiled",
        data: {
          targetSessionHash,
          tools: [{ parameters: { targetSessionHash, sessionKey: rawSessionKey } }],
        },
      },
      {
        source: "runtime",
        type: "tool.call",
        data: {
          targetSessionHash,
          arguments: { targetSessionHash, sessionKey: rawSessionKey },
        },
      },
      {
        source: "transcript",
        type: "tool.result",
        data: { targetSessionHash },
      },
      {
        source: "runtime",
        type: "tool.result",
        data: { targetSessionHash: "sha256:v1:not-canonical" },
      },
    ];
    const branchEntries = [
      {
        type: "message",
        message: {
          role: "assistant",
          targetSessionHash,
          content: [
            {
              type: "toolCall",
              arguments: { targetSessionHash, sessionKey: rawSessionKey },
            },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          targetSessionHash,
          result: { targetSessionHash, sessionKey: rawSessionKey },
          details: { targetSessionHash, sourceSessionKey: rawSessionKey },
        },
      },
    ];
    const sanitizer = new TrajectoryProvenanceSanitizer({ mode: "export" });

    const sanitized = sanitizer.sanitizeExportSnapshot({
      runtimeEvents,
      branchEntries,
      header: { type: "session" },
    });
    const transcriptEvent = sanitizer.sanitizeExportValue({
      source: "transcript",
      type: "tool.result",
      data: {
        targetSessionHash,
        result: { targetSessionHash, sessionKey: rawSessionKey },
      },
    });

    expect(sanitized.runtimeEvents[0]?.data).toEqual({
      targetSessionHash,
      arguments: {},
      result: { details: {} },
    });
    for (const event of sanitized.runtimeEvents.slice(1)) {
      expect(JSON.stringify(event)).not.toContain(targetSessionHash);
    }
    expect(JSON.stringify(sanitized.branchEntries)).not.toContain(targetSessionHash);
    expect(JSON.stringify(transcriptEvent)).not.toContain(targetSessionHash);
    expect(JSON.stringify({ sanitized, transcriptEvent })).not.toContain(rawSessionKey);
  });
});
