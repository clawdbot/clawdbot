// Mirror fence tests cover which session's writer claim a delivery mirror carries.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import type { DeliverOutboundPayloadsCoreParams } from "./deliver-contracts.js";
import { mirrorDeliveredPayloads } from "./deliver-transcript.js";
import type { NormalizedOutboundPayload } from "./payloads.js";

const mocks = vi.hoisted(() => ({
  // Typed with the append params so the recorded call is inspectable without a cast.
  appendAssistantMessageToSessionTranscript: vi.fn(
    async (_params: Record<string, unknown>) => ({ ok: true }) as const,
  ),
}));

vi.mock("../../config/sessions/transcript.runtime.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../config/sessions/transcript.runtime.js")
  >("../../config/sessions/transcript.runtime.js");
  return {
    ...actual,
    appendAssistantMessageToSessionTranscript: mocks.appendAssistantMessageToSessionTranscript,
  };
});

const RUNNING_SESSION_KEY = "agent:wolf:discord:channel:1497965766035640391";
const OTHER_SESSION_KEY = "agent:arthur:discord:channel:1538510183024689305";

function payload(text: string): NormalizedOutboundPayload {
  return { text, mediaUrls: [] };
}

async function mirrorInto(sessionKey: string): Promise<void> {
  await mirrorDeliveredPayloads({
    delivery: {
      cfg: {},
      mirror: { agentId: "wolf", sessionKey },
    } as unknown as DeliverOutboundPayloadsCoreParams,
    payloads: [payload("delivered to the user")],
    channel: "discord",
    to: "1497965766035640391",
  });
}

/** Runs a mirror inside a run that owns `RUNNING_SESSION_KEY`, the way a live delivery does. */
async function withRunningSession(run: () => Promise<void>): Promise<void> {
  await withOwnedSessionTranscriptWrites(
    {
      sessionKey: RUNNING_SESSION_KEY,
      sessionTarget: {
        agentId: "wolf",
        sessionKey: RUNNING_SESSION_KEY,
        storePath: "/state/agents/wolf/openclaw-agent.sqlite",
        expectedLifecycleRevision: "rev-7",
        expectedWriterRunId: "run-running",
      },
      withTranscriptWrite: async (operation) => await operation(),
    },
    run,
  );
}

function appendedArgs() {
  return mocks.appendAssistantMessageToSessionTranscript.mock.calls[0]?.[0];
}

describe("outbound delivery mirror writer fence", () => {
  beforeEach(() => {
    mocks.appendAssistantMessageToSessionTranscript.mockClear();
    mocks.appendAssistantMessageToSessionTranscript.mockResolvedValue({ ok: true } as const);
  });

  it("carries the running run's fence when it mirrors into that run's own session", async () => {
    await withRunningSession(async () => {
      await mirrorInto(RUNNING_SESSION_KEY);
    });

    expect(appendedArgs()).toMatchObject({
      sessionKey: RUNNING_SESSION_KEY,
      expectedWriterRunId: "run-running",
      expectedLifecycleRevision: "rev-7",
    });
  });

  it("withholds that fence when it mirrors into a different session", async () => {
    await withRunningSession(async () => {
      await mirrorInto(OTHER_SESSION_KEY);
    });

    const args = appendedArgs();
    expect(args).toMatchObject({ sessionKey: OTHER_SESSION_KEY });
    // A claim about the delivering session is not a claim about this one. Passing it made
    // the transcript guards refuse the append as "session rebound", and the refusal is
    // warn-only after a successful channel send, so the mirror was lost for good.
    expect(args).not.toHaveProperty("expectedWriterRunId");
    expect(args).not.toHaveProperty("expectedLifecycleRevision");
  });

  it("mirrors unfenced when no run owns a transcript write", async () => {
    await mirrorInto(RUNNING_SESSION_KEY);

    const args = appendedArgs();
    expect(args).toMatchObject({ sessionKey: RUNNING_SESSION_KEY });
    expect(args).not.toHaveProperty("expectedWriterRunId");
  });
});
