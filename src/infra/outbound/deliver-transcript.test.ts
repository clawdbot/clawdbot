// Boundary proof: the outbound delivery mirror fences its transcript write
// against the DESTINATION session, never against the ambient admitted run.
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import type { OwnedSessionTranscriptWriteContext } from "../../config/sessions/transcript-write-context.js";

const appendAssistantMessageToSessionTranscriptMock = vi.hoisted(() =>
  vi.fn(
    async (_params: {
      sessionKey?: string;
      expectedWriterRunId?: string;
      expectedLifecycleRevision?: string;
    }) => ({
      ok: true,
      target: { sessionId: "session-b", sessionKey: "session-b", storePath: "/tmp/store.sqlite" },
    }),
  ),
);

vi.mock("../../config/sessions/transcript.runtime.js", () => ({
  appendAssistantMessageToSessionTranscript: appendAssistantMessageToSessionTranscriptMock,
}));

const deliverTranscript = async () =>
  await import("./deliver-transcript.js").then((module) => module.mirrorDeliveredPayloads);

const passthroughWrite = async <T>(run: () => Promise<T> | T) => await run();

const ownedRunContext = (sessionKey: string): OwnedSessionTranscriptWriteContext => ({
  sessionFile: `/tmp/sessions/${sessionKey}.jsonl`,
  sessionKey,
  sessionTarget: {
    agentId: "main",
    sessionId: `session-${sessionKey}`,
    sessionKey,
    storePath: "/tmp/agents/main/agent/openclaw-agent.sqlite",
    expectedLifecycleRevision: "rev-1",
    expectedWriterRunId: `run-${sessionKey}`,
  },
  withTranscriptWrite: passthroughWrite,
});

const mirrorParams = (sessionKey: string) => ({
  delivery: {
    cfg: undefined,
    mirror: {
      agentId: "main",
      sessionKey,
      expectedSessionId: `session-${sessionKey}`,
      idempotencyKey: `mirror-${sessionKey}`,
    },
  },
  payloads: [{ text: "delivered", mediaUrls: [] }],
  channel: "discord",
  to: "channel:1",
});

describe("outbound delivery transcript mirror", () => {
  beforeEach(() => {
    appendAssistantMessageToSessionTranscriptMock.mockClear();
  });

  it("does not inherit the sending run's writer claim for another session", async () => {
    const mirrorDeliveredPayloads = await deliverTranscript();
    await withOwnedSessionTranscriptWrites(
      ownedRunContext("agent:main:discord:c:1"),
      async () => await mirrorDeliveredPayloads(mirrorParams("agent:main:discord:c:2") as never),
    );
    expect(appendAssistantMessageToSessionTranscriptMock).toHaveBeenCalledTimes(1);
    const appendParams = expectDefined(
      appendAssistantMessageToSessionTranscriptMock.mock.calls[0]?.[0],
      "transcript append call",
    );
    expect(appendParams.sessionKey).toBe("agent:main:discord:c:2");
    expect(appendParams.expectedWriterRunId).toBeUndefined();
    expect(appendParams.expectedLifecycleRevision).toBeUndefined();
  });

  it("keeps the sending run's writer claim when mirroring into its own session", async () => {
    const mirrorDeliveredPayloads = await deliverTranscript();
    await withOwnedSessionTranscriptWrites(
      ownedRunContext("agent:main:discord:c:1"),
      async () => await mirrorDeliveredPayloads(mirrorParams("agent:main:discord:c:1") as never),
    );
    const appendParams = expectDefined(
      appendAssistantMessageToSessionTranscriptMock.mock.calls[0]?.[0],
      "transcript append call",
    );
    expect(appendParams.expectedWriterRunId).toBe("run-agent:main:discord:c:1");
    expect(appendParams.expectedLifecycleRevision).toBe("rev-1");
  });
});
