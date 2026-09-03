// Tests compact-command session authority across awaited lifecycle transitions.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  abortEmbeddedAgentRun,
  buildCompactParams,
  compactEmbeddedAgentSession,
  enqueueSystemEvent,
  handleCompactCommand,
  incrementCompactionCount,
  resolveCurrentSessionEntry,
  isEmbeddedAgentRunAbortableForCompaction,
  resetCompactCommandMocks,
  waitForEmbeddedAgentRunEnd,
} from "./commands-compact.test-support.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { createReplyOperation } from "./reply-run-registry.js";

describe("handleCompactCommand lifecycle authority", () => {
  beforeEach(resetCompactCommandMocks);

  it("does not abort a run after the bound session changes", async () => {
    vi.mocked(resolveCurrentSessionEntry).mockReturnValueOnce(undefined);
    vi.mocked(isEmbeddedAgentRunAbortableForCompaction).mockReturnValueOnce(true);

    const result = await handleCompactCommand(
      {
        ...buildCompactParams("/compact", {
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
        } as OpenClawConfig),
        sessionEntry: {
          sessionId: "session-1",
          updatedAt: Date.now(),
        },
      } as HandleCommandsParams,
      true,
    );

    expect(result?.sessionCompaction).toEqual({
      compacted: false,
      reason: "command session changed",
    });
    expect(vi.mocked(isEmbeddedAgentRunAbortableForCompaction)).not.toHaveBeenCalled();
    expect(vi.mocked(abortEmbeddedAgentRun)).not.toHaveBeenCalled();
    expect(vi.mocked(compactEmbeddedAgentSession)).not.toHaveBeenCalled();
  });

  it("waits for an active embedded run before compacting even when abort is rejected", async () => {
    vi.mocked(isEmbeddedAgentRunAbortableForCompaction).mockReturnValueOnce(true);
    vi.mocked(abortEmbeddedAgentRun).mockReturnValueOnce(false);
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: true,
      compacted: false,
    });

    await handleCompactCommand(
      {
        ...buildCompactParams("/compact", {
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
        } as OpenClawConfig),
        sessionEntry: {
          sessionId: "session-1",
          updatedAt: Date.now(),
        },
      } as HandleCommandsParams,
      true,
    );

    expect(vi.mocked(abortEmbeddedAgentRun)).toHaveBeenCalledWith("session-1");
    expect(vi.mocked(waitForEmbeddedAgentRunEnd)).toHaveBeenCalledWith("session-1", 15_000);
    expect(vi.mocked(compactEmbeddedAgentSession)).toHaveBeenCalledOnce();
  });

  it("marks manual compaction as maintenance until the command finishes", async () => {
    const replyOperation = createReplyOperation({
      sessionKey: "agent:main:telegram:slash:test",
      sessionId: "command-operation",
      resetTriggered: false,
    });
    replyOperation.setPhase("running");
    vi.mocked(compactEmbeddedAgentSession).mockImplementationOnce(async () => {
      expect(replyOperation.phase).toBe("preflight_compacting");
      return { ok: true, compacted: false };
    });

    try {
      await handleCompactCommand(
        {
          ...buildCompactParams("/compact", {
            commands: { text: true },
            channels: { whatsapp: { allowFrom: ["*"] } },
          } as OpenClawConfig),
          opts: { replyOperation },
          sessionEntry: {
            sessionId: "session-1",
            updatedAt: Date.now(),
          },
        } as HandleCommandsParams,
        true,
      );

      expect(replyOperation.phase).toBe("running");
    } finally {
      replyOperation.complete();
    }
  });

  it("does not replace an active run when abort drain times out", async () => {
    vi.mocked(isEmbeddedAgentRunAbortableForCompaction).mockReturnValueOnce(true);
    vi.mocked(waitForEmbeddedAgentRunEnd).mockResolvedValueOnce(false);

    const result = await handleCompactCommand(
      {
        ...buildCompactParams("/compact", {
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
        } as OpenClawConfig),
        sessionEntry: {
          sessionId: "session-1",
          updatedAt: Date.now(),
        },
      } as HandleCommandsParams,
      true,
    );

    expect(result).toEqual({
      shouldContinue: false,
      sessionCompaction: {
        compacted: false,
        reason: "the previous run is still stopping",
      },
      reply: {
        text: "⚙️ Compaction unavailable: the previous run is still stopping.",
        isStatusNotice: true,
      },
    });
    expect(vi.mocked(abortEmbeddedAgentRun)).toHaveBeenCalledWith("session-1");
    expect(vi.mocked(waitForEmbeddedAgentRunEnd)).toHaveBeenCalledWith("session-1", 15_000);
    expect(vi.mocked(compactEmbeddedAgentSession)).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "preserves the drained writer fence and completed count, with caller abort=%s",
    async (abortAfterCompletion) => {
      const controller = new AbortController();
      const original = {
        sessionId: "session-1",
        updatedAt: 1,
        lifecycleRevision: "lifecycle",
        activeWriterRunId: "earlier-writer",
      };
      let currentEntry = original;
      vi.mocked(resolveCurrentSessionEntry).mockImplementation(({ expected }) =>
        expected.sessionId === currentEntry.sessionId ? currentEntry : undefined,
      );
      vi.mocked(isEmbeddedAgentRunAbortableForCompaction).mockReturnValueOnce(true);
      vi.mocked(waitForEmbeddedAgentRunEnd).mockImplementationOnce(async () => {
        currentEntry = { ...original, activeWriterRunId: "drained-writer" };
        return true;
      });
      vi.mocked(compactEmbeddedAgentSession).mockImplementationOnce(async (input, host) => {
        expect(input.sessionEntry).toMatchObject({ activeWriterRunId: "drained-writer" });
        host?.assertActive?.();
        if (abortAfterCompletion) {
          controller.abort(new Error("caller closed"));
        }
        return { ok: true, compacted: true, compactionKind: "native-harness" };
      });
      vi.mocked(incrementCompactionCount).mockImplementationOnce(async ({ expectedSession }) => {
        expect(expectedSession).toMatchObject({
          sessionId: "session-1",
          activeWriterRunId: "drained-writer",
        });
        return 1;
      });

      const result = await handleCompactCommand(
        {
          ...buildCompactParams("/compact", {}),
          sessionEntry: original,
          opts: { abortSignal: controller.signal },
        } as HandleCommandsParams,
        true,
      );

      expect(result?.sessionCompaction?.compacted).toBe(!abortAfterCompletion);
      expect(incrementCompactionCount).toHaveBeenCalledOnce();
      expect(enqueueSystemEvent).toHaveBeenCalledTimes(abortAfterCompletion ? 0 : 1);
      expect(currentEntry.activeWriterRunId).toBe("drained-writer");
    },
  );

  it.each([false, true])(
    "uses the host-accepted successor before accounting, with owner replacement=%s",
    async (replaceBeforeAccounting) => {
      const initial = { sessionId: "native-session", updatedAt: 1, lifecycleRevision: "lifecycle" };
      let currentSessionId = initial.sessionId;
      vi.mocked(resolveCurrentSessionEntry).mockImplementation(({ expected }) =>
        expected.sessionId === currentSessionId ? { updatedAt: 1, ...expected } : undefined,
      );
      vi.mocked(incrementCompactionCount).mockImplementationOnce(async ({ expectedSession }) => {
        expect(expectedSession?.sessionId).toBe("successor-session");
        if (replaceBeforeAccounting) {
          currentSessionId = "replacement-session";
          return undefined;
        }
        return 1;
      });
      vi.mocked(compactEmbeddedAgentSession).mockImplementationOnce(async (params, host) => {
        const storePath = params.sessionTarget?.storePath;
        if (!storePath) {
          throw new Error("expected manual compaction store");
        }
        currentSessionId = "successor-session";
        host?.onCommitted?.({
          sessionId: currentSessionId,
          sessionFile: params.sessionFile,
          sessionTarget: {
            agentId: "main",
            sessionId: currentSessionId,
            sessionKey: "agent:main:main",
            storePath,
          },
          entry: { ...initial, sessionId: currentSessionId },
          previousSessionId: initial.sessionId,
        });
        return {
          ok: true,
          compacted: true,
          compactionKind: "context-engine",
          result: {
            summary: "compacted",
            firstKeptEntryId: "first-kept",
            sessionId: currentSessionId,
            tokensBefore: 999,
            tokensAfter: 321,
          },
        };
      });

      const result = await handleCompactCommand(
        {
          ...buildCompactParams("/compact", {
            commands: { text: true },
            channels: { whatsapp: { allowFrom: ["*"] } },
          } as OpenClawConfig),
          sessionEntry: initial,
        } as HandleCommandsParams,
        true,
      );

      expect(result?.sessionCompaction).toMatchObject(
        replaceBeforeAccounting
          ? { compacted: false, reason: "command session changed" }
          : { compacted: true, tokensAfter: 321 },
      );
    },
  );
});
