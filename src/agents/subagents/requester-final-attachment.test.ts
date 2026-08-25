import { beforeEach, describe, expect, it, vi } from "vitest";

const lifecycle = vi.hoisted(() => ({
  generation: "generation-1",
  rotate: undefined as ((generation: string) => void) | undefined,
}));

vi.mock("../../infra/agent-events.js", () => ({
  getAgentEventLifecycleGeneration: () => lifecycle.generation,
  registerAgentEventLifecycleRotationHandler: (
    _key: string,
    handler: (generation: string) => void,
  ) => {
    lifecycle.rotate = handler;
  },
}));

import {
  consumeRequesterFinalAttachment,
  promoteRequesterFinalAttachment,
  registerRequesterFinalAttachment,
} from "./requester-final-attachment.js";

const base = {
  requesterAgentId: "main",
  requesterSessionKey: "agent:main:talk",
  requesterSessionId: "session-talk",
  requesterTurnRunId: "run-requester",
  lifecycleGeneration: "generation-1",
  timeoutMs: 60_000,
};

describe("requester final attachment", () => {
  beforeEach(() => {
    lifecycle.generation = "generation-1";
    lifecycle.rotate?.(lifecycle.generation);
  });

  it("promotes an exact durable batch and consumes it once", () => {
    const append = vi.fn(() => true);
    const registration = registerRequesterFinalAttachment({ ...base, append });

    expect(
      consumeRequesterFinalAttachment({
        ...base,
        batchRunIds: ["run-a", "run-b"],
        rearmGeneration: 1,
        text: "final",
      }),
    ).toBe("missing");
    expect(
      promoteRequesterFinalAttachment({
        requesterAgentId: base.requesterAgentId,
        requesterSessionKey: base.requesterSessionKey,
        requesterTurnRunId: base.requesterTurnRunId,
        batchRunIds: ["run-b", "run-a"],
        rearmGeneration: 1,
      }),
    ).toBe(true);
    registration.releaseProvisional();

    expect(
      consumeRequesterFinalAttachment({
        ...base,
        batchRunIds: ["run-a", "run-b"],
        rearmGeneration: 1,
        text: "final",
      }),
    ).toBe("appended");
    expect(append).toHaveBeenCalledExactlyOnceWith("final");
    expect(
      consumeRequesterFinalAttachment({
        ...base,
        batchRunIds: ["run-a", "run-b"],
        rearmGeneration: 1,
        text: "replay",
      }),
    ).toBe("missing");
  });

  it("rejects the wrong session or batch without consuming the owner", () => {
    const append = vi.fn(() => true);
    registerRequesterFinalAttachment({ ...base, append });
    promoteRequesterFinalAttachment({
      requesterAgentId: base.requesterAgentId,
      requesterSessionKey: base.requesterSessionKey,
      requesterTurnRunId: base.requesterTurnRunId,
      batchRunIds: ["run-a"],
      rearmGeneration: 2,
    });

    expect(
      consumeRequesterFinalAttachment({
        ...base,
        requesterSessionId: "session-other",
        batchRunIds: ["run-a"],
        rearmGeneration: 2,
        text: "wrong session",
      }),
    ).toBe("missing");
    expect(
      consumeRequesterFinalAttachment({
        ...base,
        batchRunIds: ["run-b"],
        rearmGeneration: 2,
        text: "wrong batch",
      }),
    ).toBe("missing");
    expect(
      consumeRequesterFinalAttachment({
        ...base,
        batchRunIds: ["run-a"],
        rearmGeneration: 2,
        text: "final",
      }),
    ).toBe("appended");
  });

  it("replacement and lifecycle rotation revoke stale callbacks", () => {
    const first = vi.fn(() => true);
    const second = vi.fn(() => true);
    const firstRegistration = registerRequesterFinalAttachment({ ...base, append: first });
    registerRequesterFinalAttachment({
      ...base,
      requesterTurnRunId: "run-new",
      append: second,
    });
    firstRegistration.revoke();
    expect(
      promoteRequesterFinalAttachment({
        requesterAgentId: base.requesterAgentId,
        requesterSessionKey: base.requesterSessionKey,
        requesterTurnRunId: "run-new",
        batchRunIds: ["run-new-child"],
        rearmGeneration: 1,
      }),
    ).toBe(true);

    lifecycle.generation = "generation-2";
    lifecycle.rotate?.(lifecycle.generation);
    expect(
      consumeRequesterFinalAttachment({
        ...base,
        requesterSessionId: base.requesterSessionId,
        batchRunIds: ["run-new-child"],
        rearmGeneration: 1,
        text: "stale",
      }),
    ).toBe("missing");
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  it("consumes a throwing callback without changing durable completion", () => {
    registerRequesterFinalAttachment({
      ...base,
      append: () => {
        throw new Error("socket closed");
      },
    });
    promoteRequesterFinalAttachment({
      requesterAgentId: base.requesterAgentId,
      requesterSessionKey: base.requesterSessionKey,
      requesterTurnRunId: base.requesterTurnRunId,
      batchRunIds: ["run-a"],
      rearmGeneration: 1,
    });

    expect(
      consumeRequesterFinalAttachment({
        ...base,
        batchRunIds: ["run-a"],
        rearmGeneration: 1,
        text: "final",
      }),
    ).toBe("rejected");
    expect(
      consumeRequesterFinalAttachment({
        ...base,
        batchRunIds: ["run-a"],
        rearmGeneration: 1,
        text: "replay",
      }),
    ).toBe("missing");
  });

  it("drops an expired provisional attachment", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      registerRequesterFinalAttachment({ ...base, timeoutMs: 10, append: vi.fn(() => true) });
      vi.setSystemTime(1_011);
      expect(
        promoteRequesterFinalAttachment({
          requesterAgentId: base.requesterAgentId,
          requesterSessionKey: base.requesterSessionKey,
          requesterTurnRunId: base.requesterTurnRunId,
          batchRunIds: ["run-a"],
          rearmGeneration: 1,
        }),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
