// Tests compact-command session authority across awaited lifecycle transitions.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  abortEmbeddedAgentRun,
  buildCompactParams,
  compactEmbeddedAgentSession,
  handleCompactCommand,
  incrementCompactionCount,
  isCurrentSessionEntry,
  isEmbeddedAgentRunAbortableForCompaction,
  resetCompactCommandMocks,
  waitForEmbeddedAgentRunEnd,
} from "./commands-compact.test-support.js";
import type { HandleCommandsParams } from "./commands-types.js";

describe("handleCompactCommand lifecycle authority", () => {
  beforeEach(resetCompactCommandMocks);

  it("does not abort a run after the bound session changes", async () => {
    vi.mocked(isCurrentSessionEntry).mockReturnValueOnce(false);
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

  it("accepts the successor session produced by context-engine accounting", async () => {
    let currentSessionId = "native-session";
    vi.mocked(isCurrentSessionEntry).mockImplementation(
      ({ expected }) => expected.sessionId === currentSessionId,
    );
    vi.mocked(incrementCompactionCount).mockImplementationOnce(async () => {
      currentSessionId = "successor-session";
      return 1;
    });
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: true,
      compacted: true,
      compactionKind: "context-engine",
      result: {
        summary: "compacted",
        firstKeptEntryId: "first-kept",
        sessionId: "successor-session",
        tokensBefore: 999,
        tokensAfter: 321,
      },
    });

    const result = await handleCompactCommand(
      {
        ...buildCompactParams("/compact", {
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
        } as OpenClawConfig),
        sessionEntry: {
          sessionId: "native-session",
          updatedAt: Date.now(),
        },
      } as HandleCommandsParams,
      true,
    );

    expect(result?.sessionCompaction).toMatchObject({ compacted: true, tokensAfter: 321 });
  });

  it("rejects a successor session when compaction accounting did not commit", async () => {
    let currentSessionId = "native-session";
    vi.mocked(isCurrentSessionEntry).mockImplementation(
      ({ expected }) => expected.sessionId === currentSessionId,
    );
    vi.mocked(incrementCompactionCount).mockImplementationOnce(async () => {
      currentSessionId = "successor-session";
      return undefined;
    });
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: true,
      compacted: true,
      compactionKind: "context-engine",
      result: {
        summary: "compacted",
        firstKeptEntryId: "first-kept",
        sessionId: "successor-session",
        tokensBefore: 999,
        tokensAfter: 321,
      },
    });

    const result = await handleCompactCommand(
      {
        ...buildCompactParams("/compact", {
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
        } as OpenClawConfig),
        sessionEntry: { sessionId: "native-session", updatedAt: Date.now() },
      } as HandleCommandsParams,
      true,
    );

    expect(result?.sessionCompaction).toEqual({
      compacted: false,
      reason: "command session changed",
    });
  });
});
