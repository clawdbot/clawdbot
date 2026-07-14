import { describe, expect, it, vi } from "vitest";
import type { ApplicationGateway } from "../../app/context.ts";
import { loadSkillWorkshopHistoryScanStatus, runSkillWorkshopHistoryScan } from "./history-scan.ts";
import { createSkillWorkshopState } from "./proposals.ts";
import type { SkillWorkshopHistoryScanResult } from "./state.ts";

function createSkillWorkshopHistoryScanState() {
  return createSkillWorkshopState().skillWorkshopHistoryScan;
}

function result(overrides: Partial<SkillWorkshopHistoryScanResult> = {}) {
  return {
    schema: "openclaw.skill-workshop.history-scan.v1" as const,
    hasScanned: false,
    reviewedSessions: 0,
    ideasFound: 0,
    hasMore: false,
    lastScanReviewed: 0,
    lastScanIdeas: 0,
    ...overrides,
  };
}

function gateway(request: ReturnType<typeof vi.fn>): ApplicationGateway {
  return {
    snapshot: {
      connected: true,
      client: { request },
    },
  } as unknown as ApplicationGateway;
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe("Skill Workshop history scan controller", () => {
  it("loads status and starts with the newest window", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result({ hasScanned: true, hasMore: true, reviewedSessions: 20 }));
    const state = createSkillWorkshopHistoryScanState();
    const appGateway = gateway(request);

    await loadSkillWorkshopHistoryScanStatus({ agentId: "main", gateway: appGateway, state });
    expect(state.loaded).toBe(true);

    await expect(
      runSkillWorkshopHistoryScan({ agentId: "main", gateway: appGateway, state }),
    ).resolves.toBe(true);
    expect(request).toHaveBeenLastCalledWith("skills.proposals.historyScan", {
      agentId: "main",
      direction: "older",
    });
  });

  it("switches to new work after older history is exhausted", async () => {
    const request = vi.fn().mockResolvedValue(result({ hasScanned: true }));
    const state = createSkillWorkshopHistoryScanState();
    state.loaded = true;
    state.result = result({ hasScanned: true, hasMore: false });

    await runSkillWorkshopHistoryScan({ agentId: "main", gateway: gateway(request), state });

    expect(request).toHaveBeenCalledWith("skills.proposals.historyScan", {
      agentId: "main",
      direction: "newer",
    });
  });

  it("retries a failed status load before choosing the scan direction", async () => {
    const request = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("status unavailable");
      })
      .mockResolvedValueOnce(result({ hasScanned: true, hasMore: false }))
      .mockResolvedValueOnce(result({ hasScanned: true, hasMore: false }));
    const state = createSkillWorkshopHistoryScanState();
    const appGateway = gateway(request);

    await loadSkillWorkshopHistoryScanStatus({ agentId: "main", gateway: appGateway, state });
    expect(state.loaded).toBe(true);
    expect(state.error).toBe("status unavailable");

    await expect(
      runSkillWorkshopHistoryScan({ agentId: "main", gateway: appGateway, state }),
    ).resolves.toBe(true);
    expect(request).toHaveBeenNthCalledWith(2, "skills.proposals.historyStatus", {
      agentId: "main",
    });
    expect(request).toHaveBeenNthCalledWith(3, "skills.proposals.historyScan", {
      agentId: "main",
      direction: "newer",
    });
  });

  it("uses the current gateway client after a status retry", async () => {
    const status = deferred<SkillWorkshopHistoryScanResult>();
    const oldRequest = vi.fn(() => status.promise);
    const newRequest = vi.fn().mockResolvedValue(result({ hasScanned: true, hasMore: true }));
    const state = createSkillWorkshopHistoryScanState();
    state.loaded = true;
    const appGateway = gateway(oldRequest);

    const scan = runSkillWorkshopHistoryScan({ agentId: "main", gateway: appGateway, state });
    await vi.waitFor(() => expect(oldRequest).toHaveBeenCalledTimes(1));
    (appGateway.snapshot as unknown as { client: { request: typeof newRequest } }).client = {
      request: newRequest,
    };
    status.resolve(result());

    await expect(scan).resolves.toBe(true);
    expect(newRequest).toHaveBeenCalledWith("skills.proposals.historyScan", {
      agentId: "main",
      direction: "older",
    });
  });

  it("does not race a scan against status loading", async () => {
    let resolveStatus: ((value: SkillWorkshopHistoryScanResult) => void) | undefined;
    const request = vi.fn(
      () =>
        new Promise<SkillWorkshopHistoryScanResult>((resolve) => {
          resolveStatus = resolve;
        }),
    );
    const state = createSkillWorkshopHistoryScanState();
    const appGateway = gateway(request);
    const statusLoad = loadSkillWorkshopHistoryScanStatus({
      agentId: "main",
      gateway: appGateway,
      state,
    });

    await expect(
      runSkillWorkshopHistoryScan({ agentId: "main", gateway: appGateway, state }),
    ).resolves.toBe(false);
    expect(request).toHaveBeenCalledTimes(1);

    resolveStatus?.(result());
    await statusLoad;
    expect(state.loaded).toBe(true);
  });

  it("queues another forced status read during a follow-up read", async () => {
    const first = deferred<SkillWorkshopHistoryScanResult>();
    const second = deferred<SkillWorkshopHistoryScanResult>();
    const third = deferred<SkillWorkshopHistoryScanResult>();
    const request = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);
    const state = createSkillWorkshopHistoryScanState();
    const appGateway = gateway(request);

    const initial = loadSkillWorkshopHistoryScanStatus({
      agentId: "main",
      gateway: appGateway,
      state,
    });
    const firstForce = loadSkillWorkshopHistoryScanStatus({
      agentId: "main",
      gateway: appGateway,
      state,
      force: true,
    });
    first.resolve(result());
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));

    const secondForce = loadSkillWorkshopHistoryScanStatus({
      agentId: "main",
      gateway: appGateway,
      state,
      force: true,
    });
    second.resolve(result({ hasScanned: true, reviewedSessions: 4 }));
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    third.resolve(result({ hasScanned: true, reviewedSessions: 9 }));

    await Promise.all([initial, firstForce, secondForce]);
    expect(state.result?.reviewedSessions).toBe(9);
  });

  it("reloads committed coverage after a scan returns an error", async () => {
    const committed = result({
      hasScanned: true,
      hasMore: false,
      reviewedSessions: 4,
      ideasFound: 1,
    });
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("late review failure"))
      .mockResolvedValueOnce(committed);
    const state = createSkillWorkshopHistoryScanState();
    state.loaded = true;
    state.result = result();

    await expect(
      runSkillWorkshopHistoryScan({ agentId: "main", gateway: gateway(request), state }),
    ).resolves.toBe(false);

    expect(request).toHaveBeenNthCalledWith(2, "skills.proposals.historyStatus", {
      agentId: "main",
    });
    expect(state.result).toEqual(committed);
    expect(state.error).toBe("late review failure");
  });
});
