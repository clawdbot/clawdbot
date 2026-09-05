import { beforeEach, expect, test, vi } from "vitest";
import {
  getAgentEventLifecycleGeneration,
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
} from "./agent-events.js";
import {
  claimAgentRunApprovalAuthority,
  claimAgentRunContext,
  claimAgentRunDelegatedAuthority,
  clearAgentRunContext,
  getAgentRunContext,
  registerAgentRunDelegatedAuthorityClosedHandler,
  releaseAgentRunContext,
  releaseAgentRunDelegatedAuthority,
  sweepStaleRunContexts,
  validateAgentRunDelegatedAuthority,
} from "./agent-run-registry.js";

beforeEach(() => {
  resetAgentEventsForTest();
});

test("delegated authority closes exactly once on replacement, exact close, and lifecycle rotation", () => {
  const closed: string[] = [];
  const unregister = registerAgentRunDelegatedAuthorityClosedHandler((authority) => {
    closed.push(authority.operationalRunInstance.instanceId);
  });
  try {
    claimAgentRunDelegatedAuthority({ instanceId: "instance-1", runId: "shared-run" });
    const second = claimAgentRunDelegatedAuthority({
      instanceId: "instance-2",
      runId: "shared-run",
    });
    expect(closed).toEqual(["instance-1"]);

    clearAgentRunContext("shared-run");
    expect(closed).toEqual(["instance-1"]);
    expect(releaseAgentRunDelegatedAuthority(second)).toBe(true);
    expect(closed).toEqual(["instance-1", "instance-2"]);

    claimAgentRunDelegatedAuthority({ instanceId: "instance-3", runId: "shared-run" });
    rotateAgentEventLifecycleGeneration();
    expect(closed).toEqual(["instance-1", "instance-2", "instance-3"]);
  } finally {
    unregister();
  }
});

test("authority closure reaches concurrent observers despite errors and independent unsubscribe", () => {
  const closed: string[] = [];
  const stopApprovalObserver = registerAgentRunDelegatedAuthorityClosedHandler((authority) => {
    closed.push(`approval:${authority.operationalRunInstance.instanceId}`);
  });
  const stopFaultyObserver = registerAgentRunDelegatedAuthorityClosedHandler(() => {
    throw new Error("observer failed");
  });
  const stopTransferObserver = registerAgentRunDelegatedAuthorityClosedHandler((authority) => {
    closed.push(`transfer:${authority.operationalRunInstance.instanceId}`);
  });
  try {
    const first = claimAgentRunDelegatedAuthority({ instanceId: "first", runId: "run" });
    releaseAgentRunDelegatedAuthority(first);
    expect(closed).toEqual(["approval:first", "transfer:first"]);
    stopTransferObserver();
    const second = claimAgentRunDelegatedAuthority({ instanceId: "second", runId: "run" });
    releaseAgentRunDelegatedAuthority(second);
    expect(closed).toEqual(["approval:first", "transfer:first", "approval:second"]);
  } finally {
    stopTransferObserver();
    stopFaultyObserver();
    stopApprovalObserver();
  }
});

test.each(["close", "replacement", "restart"])(
  "approval generations retain all signal fences and close with parent %s",
  (reason) => {
    const instance = { instanceId: "instance-scopes", runId: "run-scopes" };
    const parent = claimAgentRunDelegatedAuthority(instance);
    const outer = new AbortController();
    const inner = new AbortController();
    const scope = claimAgentRunApprovalAuthority(parent, [outer.signal, inner.signal]);
    const copied = { ...scope, operationalRunInstance: { ...instance } };
    expect(claimAgentRunApprovalAuthority(parent, [inner.signal, outer.signal])).toBe(scope);
    expect(validateAgentRunDelegatedAuthority(copied)).toBe(true);
    inner.abort();
    expect(validateAgentRunDelegatedAuthority(copied)).toBe(false);
    expect(validateAgentRunDelegatedAuthority(parent)).toBe(true);

    const next = claimAgentRunApprovalAuthority(parent, [outer.signal]);
    if (reason === "close") {
      releaseAgentRunDelegatedAuthority(parent);
    } else if (reason === "replacement") {
      claimAgentRunDelegatedAuthority({ ...instance, instanceId: "replacement" });
    } else {
      rotateAgentEventLifecycleGeneration();
    }
    expect(validateAgentRunDelegatedAuthority(next)).toBe(false);
    outer.abort();
  },
);

test("stale projection sweeping cannot retire a live delegated authority claim", () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(100);
  const authority = claimAgentRunDelegatedAuthority({
    instanceId: "instance-live",
    runId: "live-run",
  });
  clock.mockReturnValue(10_000);

  expect(sweepStaleRunContexts(500)).toBe(0);
  expect(getAgentRunContext(authority.operationalRunInstance.runId)).toBeDefined();
  clock.mockRestore();
});

test("terminal clear preserves exact authority until its outer owner closes", () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(100);
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const delayedOwner = claimAgentRunContext(
    "delayed-terminal-run",
    { lifecycleGeneration, sessionKey: "agent:main:delayed" },
    { trackOwner: true },
  );
  const closed: string[] = [];
  const unregister = registerAgentRunDelegatedAuthorityClosedHandler((authority) => {
    closed.push(authority.claimId);
  });
  try {
    const authority = claimAgentRunDelegatedAuthority({
      instanceId: "instance-delayed",
      runId: "delayed-terminal-run",
    });
    const copiedAuthority = {
      ...authority,
      operationalRunInstance: { ...authority.operationalRunInstance },
    };
    expect(validateAgentRunDelegatedAuthority(copiedAuthority)).toBe(true);
    clearAgentRunContext("delayed-terminal-run", lifecycleGeneration);

    expect(closed).toEqual([]);
    expect(getAgentRunContext("delayed-terminal-run")).toBeDefined();
    clock.mockReturnValue(10_000);
    expect(sweepStaleRunContexts(500)).toBe(0);
    expect(validateAgentRunDelegatedAuthority(copiedAuthority)).toBe(true);
    expect(releaseAgentRunDelegatedAuthority(authority)).toBe(true);
    expect(closed).toEqual([authority.claimId]);
    expect(validateAgentRunDelegatedAuthority(copiedAuthority)).toBe(false);
    expect(getAgentRunContext("delayed-terminal-run")).toBeDefined();
    releaseAgentRunContext("delayed-terminal-run", delayedOwner);
    expect(getAgentRunContext("delayed-terminal-run")).toBeUndefined();
  } finally {
    clock.mockRestore();
    unregister();
  }
});

test("same-generation stale terminal clear cannot revoke a reused-run successor", () => {
  const runId = "same-generation-successor";
  claimAgentRunDelegatedAuthority({ instanceId: "old-instance", runId });
  const successor = claimAgentRunDelegatedAuthority({ instanceId: "new-instance", runId });

  clearAgentRunContext(runId, getAgentEventLifecycleGeneration());

  expect(validateAgentRunDelegatedAuthority(successor)).toBe(true);
  expect(releaseAgentRunDelegatedAuthority(successor)).toBe(true);
});
