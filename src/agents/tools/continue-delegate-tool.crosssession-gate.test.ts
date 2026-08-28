import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getContinuationDelegateQueueDepths } from "../../auto-reply/continuation/delegate-flow-store.js";
import {
  cancelPendingDelegates,
  consumePendingDelegates,
  resetDelegateStoreForTests,
} from "../../auto-reply/continuation/delegate-store.js";
import { resetContinueDelegateTurnAdmissionForTests } from "../../auto-reply/continuation/delegate-turn-admission.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../../config/config.js";
import { createContinueDelegateTool } from "./continue-delegate-tool.js";

const DISPATCHING_SESSION = "agent:main:self";

function continuationConfig(crossSessionTargeting: "disabled" | "enabled"): OpenClawConfig {
  return {
    agents: {
      defaults: {
        continuation: {
          enabled: true,
          maxDelegatesPerTurn: 5,
          crossSessionTargeting,
        },
      },
    },
  };
}

async function executeContinueDelegate(params: {
  crossSessionTargeting: "disabled" | "enabled";
  args?: Record<string, unknown>;
}) {
  setRuntimeConfigSnapshot(continuationConfig(params.crossSessionTargeting));
  const tool = createContinueDelegateTool({ agentSessionKey: DISPATCHING_SESSION });
  return (await tool.execute("call", { task: "delegate task", ...params.args }))?.details as
    | Record<string, unknown>
    | undefined;
}

async function expectContinueDelegateError(params: {
  crossSessionTargeting: "disabled" | "enabled";
  args?: Record<string, unknown>;
}): Promise<Error> {
  try {
    await executeContinueDelegate(params);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("expected continue_delegate to reject");
}

describe("continue_delegate cross-session targeting gate", () => {
  beforeEach(() => {
    resetDelegateStoreForTests();
    resetContinueDelegateTurnAdmissionForTests();
    clearRuntimeConfigSnapshot();
  });

  afterEach(() => {
    cancelPendingDelegates(DISPATCHING_SESSION);
    resetDelegateStoreForTests();
    resetContinueDelegateTurnAdmissionForTests();
    clearRuntimeConfigSnapshot();
  });

  it("case 1: disabled rejects targetSessionKey for another session", async () => {
    await expect(
      executeContinueDelegate({
        crossSessionTargeting: "disabled",
        args: { targetSessionKey: "agent:main:other" },
      }),
    ).rejects.toThrow("cross-session continuation targeting is disabled");
    expect(consumePendingDelegates(DISPATCHING_SESSION)).toEqual([]);
  });

  it("case 2: disabled rejects targetSessionKeys", async () => {
    await expect(
      executeContinueDelegate({
        crossSessionTargeting: "disabled",
        args: { targetSessionKeys: ["agent:main:a", "agent:main:b"] },
      }),
    ).rejects.toThrow("cross-session continuation targeting is disabled");
    expect(consumePendingDelegates(DISPATCHING_SESSION)).toEqual([]);
  });

  it("case 3: disabled allows fanoutMode=tree", async () => {
    const result = await executeContinueDelegate({
      crossSessionTargeting: "disabled",
      args: { fanoutMode: "tree" },
    });
    expect(result).toMatchObject({ status: "scheduled", fanoutMode: "tree" });
    expect(consumePendingDelegates(DISPATCHING_SESSION)).toEqual([
      expect.objectContaining({ fanoutMode: "tree" }),
    ]);
  });

  it("case 4: disabled rejects fanoutMode=all", async () => {
    await expect(
      executeContinueDelegate({
        crossSessionTargeting: "disabled",
        args: { fanoutMode: "all" },
      }),
    ).rejects.toThrow("cross-session continuation targeting is disabled");
    expect(consumePendingDelegates(DISPATCHING_SESSION)).toEqual([]);
  });

  it("case 5: disabled allows no targeting", async () => {
    const result = await executeContinueDelegate({ crossSessionTargeting: "disabled" });
    expect(result).toMatchObject({ status: "scheduled" });
    expect(consumePendingDelegates(DISPATCHING_SESSION)).toEqual([
      expect.objectContaining({ task: "delegate task" }),
    ]);
  });

  it("case 6: disabled allows normalized self targeting", async () => {
    const selfKeyResult = await executeContinueDelegate({
      crossSessionTargeting: "disabled",
      args: { targetSessionKey: ` ${DISPATCHING_SESSION} ` },
    });
    expect(selfKeyResult).toMatchObject({
      status: "scheduled",
      targetSessionKey: DISPATCHING_SESSION,
    });
    expect(consumePendingDelegates(DISPATCHING_SESSION)).toEqual([
      expect.objectContaining({ targetSessionKey: DISPATCHING_SESSION }),
    ]);

    resetDelegateStoreForTests();
    const selfKeysResult = await executeContinueDelegate({
      crossSessionTargeting: "disabled",
      args: { targetSessionKeys: [DISPATCHING_SESSION, ` ${DISPATCHING_SESSION} `] },
    });
    expect(selfKeysResult).toMatchObject({
      status: "scheduled",
      targetSessionKeys: [DISPATCHING_SESSION],
    });
    expect(consumePendingDelegates(DISPATCHING_SESSION)).toEqual([
      expect.objectContaining({ targetSessionKeys: [DISPATCHING_SESSION] }),
    ]);
  });

  it("case 8: enabled allows targetSessionKey for another session", async () => {
    const result = await executeContinueDelegate({
      crossSessionTargeting: "enabled",
      args: { targetSessionKey: "agent:main:other" },
    });
    expect(result).toMatchObject({
      status: "scheduled",
      targetSessionKey: "agent:main:other",
    });
    expect(consumePendingDelegates(DISPATCHING_SESSION)).toEqual([
      expect.objectContaining({ targetSessionKey: "agent:main:other" }),
    ]);
  });

  it("case 9: enabled allows fanoutMode=all", async () => {
    const result = await executeContinueDelegate({
      crossSessionTargeting: "enabled",
      args: { fanoutMode: "all" },
    });
    expect(result).toMatchObject({ status: "scheduled", fanoutMode: "all" });
    expect(consumePendingDelegates(DISPATCHING_SESSION)).toEqual([
      expect.objectContaining({ fanoutMode: "all" }),
    ]);
  });

  it("case 12: schema conflict takes precedence over policy rejection", async () => {
    const error = await expectContinueDelegateError({
      crossSessionTargeting: "disabled",
      args: { fanoutMode: "tree", targetSessionKey: "agent:main:other" },
    });

    expect(error.message).toContain(
      "fanoutMode cannot be combined with targetSessionKey or targetSessionKeys.",
    );
    expect(error.message).not.toContain("cross-session continuation targeting is disabled");
    expect(consumePendingDelegates(DISPATCHING_SESSION)).toEqual([]);
  });

  it("case 13: disabled rejects mixed self and cross-session targetSessionKeys without enqueueing", async () => {
    await expectContinueDelegateError({
      crossSessionTargeting: "disabled",
      args: { targetSessionKeys: [DISPATCHING_SESSION, "agent:main:other"] },
    });

    expect(getContinuationDelegateQueueDepths(DISPATCHING_SESSION)).toMatchObject({
      pendingQueued: 0,
      stagedPostCompaction: 0,
      totalQueued: 0,
    });
    expect(consumePendingDelegates(DISPATCHING_SESSION)).toEqual([]);
  });

  it("case 14: disabled rejects cross-session post-compaction delegate without staging", async () => {
    await expectContinueDelegateError({
      crossSessionTargeting: "disabled",
      args: {
        mode: "post-compaction",
        targetSessionKey: "agent:main:other",
      },
    });

    expect(getContinuationDelegateQueueDepths(DISPATCHING_SESSION)).toMatchObject({
      pendingQueued: 0,
      stagedPostCompaction: 0,
      totalQueued: 0,
    });
  });

  it("case 16: disabled rejects post-compaction fanoutMode=all without staging", async () => {
    await expectContinueDelegateError({
      crossSessionTargeting: "disabled",
      args: {
        mode: "post-compaction",
        fanoutMode: "all",
      },
    });

    expect(getContinuationDelegateQueueDepths(DISPATCHING_SESSION)).toMatchObject({
      pendingQueued: 0,
      stagedPostCompaction: 0,
      totalQueued: 0,
    });
  });
});
