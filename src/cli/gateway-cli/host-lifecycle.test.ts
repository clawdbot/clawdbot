import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareHostedGatewayStop, type HostedGatewayStop } from "../../daemon/hosted-stop.js";
import { getGatewayProcessInstanceId } from "../../gateway/process-instance.js";
import {
  armGatewaySuspendHandoff,
  consumeGatewaySuspendHandoff,
  prepareGatewaySuspend,
  resumeGatewaySuspend,
} from "../../infra/gateway-suspend-coordinator.js";
import { scheduleSafeGatewayRestart } from "../../infra/restart-coordinator.js";
import { createGatewayHostLifecycle } from "./host-lifecycle.js";

vi.mock("../../daemon/hosted-stop.js", () => ({ prepareHostedGatewayStop: vi.fn() }));
vi.mock("../../infra/restart-coordinator.js", () => ({ scheduleSafeGatewayRestart: vi.fn() }));

describe("Gateway host lifecycle authority", () => {
  let current = true;
  let serving = true;
  const acceptStop = vi.fn();
  const execute = vi.fn<HostedGatewayStop["execute"]>();
  const dispose = vi.fn<HostedGatewayStop["dispose"]>();
  const owners: ReturnType<typeof createGatewayHostLifecycle>[] = [];
  const owner = () => {
    const host = createGatewayHostLifecycle({
      isCurrent: () => current,
      isServing: () => serving,
      acceptStop,
      processOwner: { ownsProcessLifecycle: true, supervisor: null },
    });
    owners.push(host);
    return host;
  };

  beforeEach(() => {
    vi.resetAllMocks();
    dispose.mockResolvedValue(undefined);
    current = serving = true;
    execute.mockResolvedValue({ outcome: "accepted" });
    vi.mocked(prepareHostedGatewayStop).mockResolvedValue({ execute, dispose });
    acceptStop.mockImplementation(() => {
      serving = false;
    });
  });
  afterEach(async () => {
    for (const host of owners.splice(0)) {
      await host.retire();
    }
  });

  it("reports an already-running start and a local scheduled restart without native discovery", async () => {
    const host = owner();
    const guard = vi.fn();
    await expect(host.capability.request("start", guard)).resolves.toEqual({
      ok: true,
      value: { outcome: "already-running" },
    });
    await expect(host.capability.request("restart", guard)).resolves.toEqual({
      ok: true,
      value: { outcome: "scheduled" },
    });
    expect(prepareHostedGatewayStop).not.toHaveBeenCalled();
    expect(scheduleSafeGatewayRestart).toHaveBeenCalledExactlyOnceWith({
      reason: "gateway.restart.safe",
      delayMs: 0,
    });
    expect(guard).toHaveBeenCalledTimes(2);
  });

  it("transfers only the accepted stop across teardown, without awaiting native completion", async () => {
    const host = owner();
    await expect(host.capability.request("stop", () => {})).resolves.toEqual({
      ok: true,
      value: { outcome: "scheduled" },
    });
    expect(acceptStop).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    await expect(host.capability.request("start", () => {})).resolves.toMatchObject({ ok: false });
    await expect(host.finishStop()).resolves.toEqual({ outcome: "accepted" });
    expect(execute).toHaveBeenCalledOnce();
    await expect(host.finishStop()).resolves.toEqual({ outcome: "retired" });
  });

  it.each(["retired", "replaced", "closed", "approval revoked"])(
    "rejects after awaited preparation when %s",
    async (change) => {
      const host = owner();
      let approve = true;
      let resolvePreparation!: (stop: HostedGatewayStop) => void;
      vi.mocked(prepareHostedGatewayStop).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvePreparation = resolve;
          }),
      );
      const request = host.capability.request("stop", () => {
        if (!approve) {
          throw new Error("approval revoked");
        }
      });
      const retirement = change === "retired" ? host.retire() : undefined;
      if (change === "replaced") {
        current = false;
      }
      if (change === "closed") {
        serving = false;
      }
      if (change === "approval revoked") {
        approve = false;
      }
      resolvePreparation({ execute, dispose });
      await expect(request).resolves.toMatchObject({ ok: false });
      await retirement;
      expect(acceptStop).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledOnce();
    },
  );

  it("keeps serving on preparation failure and preserves a concurrent preparation owner", async () => {
    const host = owner();
    let rejectPreparation!: (error: Error) => void;
    vi.mocked(prepareHostedGatewayStop).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectPreparation = reject;
        }),
    );
    const first = host.capability.request("stop", () => {});
    await expect(host.capability.request("stop", () => {})).resolves.toMatchObject({ ok: false });
    await expect(host.capability.request("stop", () => {})).resolves.toMatchObject({ ok: false });
    expect(prepareHostedGatewayStop).toHaveBeenCalledOnce();
    rejectPreparation(new Error("native permission denied"));
    await expect(first).resolves.toEqual({ ok: false, error: "native permission denied" });
    expect(acceptStop).not.toHaveBeenCalled();
    await expect(host.capability.request("start", () => {})).resolves.toMatchObject({ ok: true });
  });

  it("retires accepted native authority on preemption", async () => {
    const host = owner();
    await host.capability.request("stop", () => {});
    await host.retire();
    await expect(host.finishStop()).resolves.toEqual({ outcome: "retired" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not carry an armed lease into another host iteration in the same process", async () => {
    const first = owner();
    const processInstanceId = getGatewayProcessInstanceId();
    const lease = prepareGatewaySuspend({
      requestId: "host-iteration-handoff",
      drain: true,
      pauseScheduling: () => {},
      resumeScheduling: () => {},
      inspect: { getRootRequests: () => 1, getTerminalPersistence: () => 0 },
    });
    if (lease.status !== "draining" || !first.capability.externalRestart) {
      throw new Error("missing owned lease");
    }
    try {
      expect(
        armGatewaySuspendHandoff({
          suspensionId: lease.suspensionId,
          owner: first.capability.externalRestart,
        }).ok,
      ).toBe(true);
      await first.retire();
      const next = owner();
      expect(getGatewayProcessInstanceId()).toBe(processInstanceId);
      expect(first.capability.externalRestart.isCurrent()).toBe(false);
      expect(next.capability.externalRestart?.isCurrent()).toBe(true);
      expect(consumeGatewaySuspendHandoff(first.capability.externalRestart)).toEqual({
        ok: true,
        value: false,
      });
      expect(consumeGatewaySuspendHandoff(next.capability.externalRestart)).toEqual({
        ok: true,
        value: false,
      });
    } finally {
      resumeGatewaySuspend(lease.suspensionId);
    }
  });

  it.each(["preparing", "accepted"])(
    "joins %s executor cleanup before retiring the owner",
    async (phase) => {
      const host = owner();
      let finishClose!: () => void;
      dispose.mockImplementation(
        () =>
          new Promise((resolve) => {
            finishClose = resolve;
          }),
      );
      let finishPrepare!: (stop: HostedGatewayStop) => void;
      if (phase === "preparing") {
        vi.mocked(prepareHostedGatewayStop).mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishPrepare = resolve;
            }),
        );
      }
      const request = host.capability.request("stop", () => {});
      if (phase === "accepted") {
        await request;
      }
      let retired = false;
      const retirement = host.retire().then(() => {
        retired = true;
      });
      if (phase === "preparing") {
        finishPrepare({ execute, dispose });
      }
      await expect(host.capability.request("restart", () => {})).resolves.toMatchObject({
        ok: false,
      });
      expect(retired).toBe(false);
      expect(execute).not.toHaveBeenCalled();
      finishClose();
      await retirement;
      await request;
      expect(dispose).toHaveBeenCalledOnce();
    },
  );

  it("joins an in-flight native inspection on retirement and discards its late result", async () => {
    const host = owner();
    let finishNative!: (result: { outcome: "accepted" }) => void;
    execute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishNative = resolve;
        }),
    );
    await host.capability.request("stop", () => {});
    const finishing = host.finishStop();
    let retired = false;
    const retirement = host.retire().then(() => {
      retired = true;
    });
    try {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(retired).toBe(false);
      current = false;
    } finally {
      finishNative({ outcome: "accepted" });
    }
    await expect(finishing).resolves.toEqual({ outcome: "retired" });
    await retirement;
  });
});
