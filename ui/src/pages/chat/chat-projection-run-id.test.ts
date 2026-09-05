/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import * as chatThread from "./chat-thread.ts";
import { projectChatTranscript } from "./components/chat-transcript-projection.ts";
import { threadProps } from "./components/chat-transcript.test-support.ts";
import { resolveChatProjectionRunId } from "./tool-stream-status.ts";

describe("resolveChatProjectionRunId", () => {
  it("restores only an active run proven by the reconnecting outbox", () => {
    const reconnecting = {
      id: "reconnecting",
      text: "Current prompt",
      createdAt: 1,
      sendRunId: "run-restored",
      sendState: "waiting-reconnect" as const,
    };

    expect(
      resolveChatProjectionRunId({
        activeRunIds: ["run-restored"],
        queue: [reconnecting],
      }),
    ).toBe("run-restored");
    expect(
      resolveChatProjectionRunId({
        activeRunIds: ["run-stale"],
        queue: [reconnecting],
      }),
    ).toBeNull();
    expect(
      resolveChatProjectionRunId({
        localRunId: "run-local",
        activeRunIds: ["run-restored"],
        queue: [reconnecting],
      }),
    ).toBe("run-local");
  });
});

describe("transcript run identity", () => {
  it("does not project a session row's first active run without an explicit run id", () => {
    const build = vi.spyOn(chatThread, "buildCachedChatItems").mockReturnValue([]);

    projectChatTranscript(
      {
        ...threadProps("run-id-projection"),
        sessions: {
          ts: 0,
          path: "",
          count: 1,
          defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
          sessions: [
            {
              key: "agent:main:main",
              kind: "direct",
              updatedAt: 1,
              hasActiveRun: true,
              activeRunIds: ["arbitrary-first", "other-run"],
            },
          ],
        },
      },
      {
        expandedAssistantMessages: new Map(),
        setContentReady: vi.fn(),
        syncMessageRows: vi.fn(),
      } as unknown as Parameters<typeof projectChatTranscript>[1],
    );

    expect(build).toHaveBeenCalledWith(expect.objectContaining({ runId: null }));
  });
});
