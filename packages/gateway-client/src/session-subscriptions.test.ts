import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  GatewayProtocolRequestTimeoutError,
  type GatewayProtocolRequestOptions,
} from "./protocol-request.js";
import {
  GatewaySessionMessageSubscriptionCoordinator,
  getGatewaySessionMessageSubscriptionCoordinator,
  releaseGatewaySessionMessageSubscription,
  resetGatewaySessionMessageSubscriptionCoordinator,
  type GatewaySessionMessageRequestClient,
} from "./session-subscriptions.js";
import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "./timeouts.js";

type SessionRequestHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>;

function createClient(
  handler: SessionRequestHandler = async (method, params) =>
    method === "sessions.messages.subscribe" ? { key: params.key } : {},
) {
  const request = vi.fn(handler);
  return {
    client: {
      request: (method: string, params: Record<string, unknown>) => request(method, params),
    } as unknown as GatewaySessionMessageRequestClient,
    request,
  };
}

function createStalledRequestClient(stalledMethod: string, stalledKey: string) {
  let shouldStall = true;
  const request = vi.fn(
    (
      method: string,
      params: Record<string, unknown>,
      options?: GatewayProtocolRequestOptions,
    ): Promise<unknown> => {
      if (shouldStall && method === stalledMethod && params.key === stalledKey) {
        shouldStall = false;
        return new Promise((_, reject) => {
          const timeoutMs = options?.timeoutMs;
          if (typeof timeoutMs === "number") {
            setTimeout(
              () =>
                reject(
                  new GatewayProtocolRequestTimeoutError({
                    method,
                    timeoutMs,
                    requestSent: true,
                  }),
                ),
              timeoutMs,
            );
          }
        });
      }
      return Promise.resolve(method === "sessions.messages.subscribe" ? { key: params.key } : {});
    },
  );
  return {
    client: { request } as unknown as GatewaySessionMessageRequestClient,
    request,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("GatewaySessionMessageSubscriptionCoordinator", () => {
  it("shares one in-flight wire subscription across canonical session aliases", async () => {
    const { client, request } = createClient();
    const coordinator = new GatewaySessionMessageSubscriptionCoordinator(client, {
      keysEquivalent: (left, right) =>
        left.replace("agent:main:main", "main") === right.replace("agent:main:main", "main"),
    });

    const [first, second] = await Promise.all([
      coordinator.acquire("main"),
      coordinator.acquire("agent:main:main"),
    ]);

    expect(request).toHaveBeenCalledOnce();
    expect(first).not.toBe(second);
    expect(first).toEqual({ key: "main", agentId: null });
    expect(second).toEqual({ key: "main", agentId: null });

    await coordinator.release(first);
    expect(request).toHaveBeenCalledOnce();
    await coordinator.release(second);
    expect(request).toHaveBeenNthCalledWith(2, "sessions.messages.unsubscribe", { key: "main" });
  });

  it("uses the Gateway canonical key when releasing a requested alias", async () => {
    const { client, request } = createClient(async (method) =>
      method === "sessions.messages.subscribe" ? { key: "agent:main:main" } : {},
    );
    const coordinator = new GatewaySessionMessageSubscriptionCoordinator(client);

    const subscription = await coordinator.acquire("main");
    expect(subscription).toEqual({ key: "agent:main:main", agentId: null });

    await coordinator.release(subscription);
    expect(request).toHaveBeenLastCalledWith("sessions.messages.unsubscribe", {
      key: "agent:main:main",
    });
  });

  it("retains the requested alias after the Gateway returns a canonical key", async () => {
    const { client, request } = createClient(async (method) =>
      method === "sessions.messages.subscribe" ? { key: "agent:main:main" } : {},
    );
    const coordinator = new GatewaySessionMessageSubscriptionCoordinator(client);

    const first = await coordinator.acquire("main");
    const second = await coordinator.acquire("main");

    expect(first).not.toBe(second);
    expect(first).toEqual({ key: "agent:main:main", agentId: null });
    expect(second).toEqual({ key: "agent:main:main", agentId: null });
    expect(request).toHaveBeenCalledExactlyOnceWith("sessions.messages.subscribe", {
      key: "main",
    });

    await coordinator.release(first);
    expect(request).toHaveBeenCalledOnce();
    await coordinator.release(second);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith("sessions.messages.unsubscribe", {
      key: "agent:main:main",
    });
  });

  it("shares requested and acknowledged canonical aliases without a custom matcher", async () => {
    const { client, request } = createClient(async (method) =>
      method === "sessions.messages.subscribe" ? { key: "agent:main:main" } : {},
    );
    const coordinator = new GatewaySessionMessageSubscriptionCoordinator(client);

    const requested = await coordinator.acquire("main");
    const canonical = await coordinator.acquire("agent:main:main");

    expect(request).toHaveBeenCalledExactlyOnceWith("sessions.messages.subscribe", {
      key: "main",
    });
    expect(requested.key).toBe("agent:main:main");
    expect(canonical.key).toBe("agent:main:main");

    await coordinator.release(requested);
    expect(request).toHaveBeenCalledOnce();
    await coordinator.release(canonical);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith("sessions.messages.unsubscribe", {
      key: "agent:main:main",
    });
  });

  it.each([
    { name: "default main", requestedKey: "main", canonicalKey: "agent:main:main" },
    {
      name: "configured main",
      requestedKey: "agent:ops:main",
      canonicalKey: "agent:ops:work",
    },
    { name: "global main", requestedKey: "agent:ops:main", canonicalKey: "global" },
  ])(
    "coalesces $name aliases before the first canonical acknowledgment",
    async ({ requestedKey, canonicalKey }) => {
      const acknowledgement = createDeferred<unknown>();
      const { client, request } = createClient(async (method) =>
        method === "sessions.messages.subscribe" ? await acknowledgement.promise : {},
      );
      const coordinator = new GatewaySessionMessageSubscriptionCoordinator(client);

      const requested = coordinator.acquire(requestedKey);
      const canonical = coordinator.acquire(canonicalKey);

      expect(request).toHaveBeenCalledExactlyOnceWith("sessions.messages.subscribe", {
        key: requestedKey,
      });

      acknowledgement.resolve({ key: canonicalKey });
      const [first, second] = await Promise.all([requested, canonical]);

      expect(first).not.toBe(second);
      expect(first).toEqual({ key: canonicalKey, agentId: null });
      expect(second).toEqual({ key: canonicalKey, agentId: null });
      expect(request).toHaveBeenCalledOnce();

      await coordinator.release(first);
      expect(request).toHaveBeenCalledOnce();
      await coordinator.release(second);
      expect(request).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenLastCalledWith("sessions.messages.unsubscribe", {
        key: canonicalKey,
      });
    },
  );

  it("upgrades a provisional canonical alias without creating a competing plain observer", async () => {
    const acknowledgement = createDeferred<unknown>();
    const replay = { approvals: [{ id: "approval-after-ack" }] };
    const { client, request } = createClient(async (method, params) => {
      if (method === "sessions.messages.unsubscribe") {
        return {};
      }
      if (params.includeApprovals) {
        return { key: "agent:main:main", approvalReplay: replay };
      }
      return await acknowledgement.promise;
    });
    const coordinator = new GatewaySessionMessageSubscriptionCoordinator(client);

    const requested = coordinator.acquire("main");
    const approval = coordinator.acquire("agent:main:main", { includeApprovals: true });
    expect(request).toHaveBeenCalledOnce();

    acknowledgement.resolve({ key: "agent:main:main" });
    const [plain, upgraded] = await Promise.all([requested, approval]);

    expect(upgraded).toEqual({
      key: "agent:main:main",
      agentId: null,
      includeApprovals: true,
      approvalReplay: replay,
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(2, "sessions.messages.subscribe", {
      key: "agent:main:main",
      includeApprovals: true,
    });

    await coordinator.release(plain);
    expect(request).toHaveBeenCalledTimes(2);
    await coordinator.release(upgraded);
    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenLastCalledWith("sessions.messages.unsubscribe", {
      key: "agent:main:main",
    });
  });

  it("keeps unacknowledged subscriptions isolated by canonical agent", async () => {
    const acknowledgement = createDeferred<unknown>();
    const { client, request } = createClient(async (_method, params) =>
      params.agentId === "main" ? await acknowledgement.promise : { key: params.key },
    );
    const coordinator = new GatewaySessionMessageSubscriptionCoordinator(client);

    const main = coordinator.acquire("global", { agentId: "main" });
    const research = await coordinator.acquire("global", { agentId: "research" });

    expect(research).toEqual({ key: "global", agentId: "research" });
    expect(request).toHaveBeenCalledTimes(2);
    acknowledgement.resolve({ key: "global" });
    await expect(main).resolves.toEqual({ key: "global", agentId: "main" });
  });

  it("subscribes another session before its agent's stalled subscription times out", async () => {
    vi.useFakeTimers();
    const { client, request } = createStalledRequestClient(
      "sessions.messages.subscribe",
      "stalled",
    );
    const coordinator = new GatewaySessionMessageSubscriptionCoordinator(client);
    let failure: unknown;

    void coordinator.acquire("stalled").catch((error: unknown) => {
      failure = error;
    });
    const recovered = coordinator.acquire("healthy");
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(
      2,
      "sessions.messages.subscribe",
      { key: "healthy" },
      { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS },
    );
    await expect(recovered).resolves.toEqual({ key: "healthy", agentId: null });
    expect(failure).toBeUndefined();

    await vi.advanceTimersByTimeAsync(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS);

    expect(failure).toBeInstanceOf(GatewayProtocolRequestTimeoutError);
    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenNthCalledWith(
      3,
      "sessions.messages.unsubscribe",
      { key: "stalled" },
      { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS },
    );
  });

  it("does not compensate an unsent subscription timeout", async () => {
    const timeout = new GatewayProtocolRequestTimeoutError({
      method: "sessions.messages.subscribe",
      timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
      requestSent: false,
    });
    const request = vi.fn(async () => {
      throw timeout;
    });
    const coordinator = new GatewaySessionMessageSubscriptionCoordinator({ request });

    await expect(coordinator.acquire("main")).rejects.toBe(timeout);
    expect(request).toHaveBeenCalledOnce();
  });

  it("retries a rejected final unsubscribe with the original live lease", async () => {
    let unsubscribeCount = 0;
    const { client, request } = createClient(async (method, params) => {
      if (method === "sessions.messages.subscribe") {
        return { key: params.key };
      }
      unsubscribeCount += 1;
      if (unsubscribeCount === 1) {
        throw new Error("temporary unsubscribe failure");
      }
      return {};
    });
    const coordinator = new GatewaySessionMessageSubscriptionCoordinator(client);
    const subscription = await coordinator.acquire("main");

    await expect(coordinator.release(subscription)).rejects.toThrow(
      "temporary unsubscribe failure",
    );
    await expect(coordinator.release(subscription)).resolves.toBeUndefined();

    expect(unsubscribeCount).toBe(2);
    expect(request).toHaveBeenCalledTimes(3);
    await expect(coordinator.release(subscription)).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("keeps a timed-out final unsubscribe retryable on its original lease", async () => {
    vi.useFakeTimers();
    const { client, request } = createStalledRequestClient("sessions.messages.unsubscribe", "main");
    const coordinator = new GatewaySessionMessageSubscriptionCoordinator(client);
    const subscription = await coordinator.acquire("main");
    let failure: unknown;

    void coordinator.release(subscription).catch((error: unknown) => {
      failure = error;
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS);

    expect(failure).toBeInstanceOf(GatewayProtocolRequestTimeoutError);
    await expect(coordinator.release(subscription)).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("coalesces concurrent releases of the final lease", async () => {
    const unsubscribe = createDeferred<unknown>();
    const { client, request } = createClient(async (method, params) =>
      method === "sessions.messages.subscribe" ? { key: params.key } : await unsubscribe.promise,
    );
    const coordinator = new GatewaySessionMessageSubscriptionCoordinator(client);
    const subscription = await coordinator.acquire("main");

    const first = coordinator.release(subscription);
    const second = coordinator.release(subscription);

    expect(first).toBe(second);
    expect(request).toHaveBeenCalledTimes(2);
    unsubscribe.resolve({});
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });

  it("waits for a closing observer before acquiring its replacement", async () => {
    const unsubscribe = createDeferred<unknown>();
    const { client, request } = createClient(async (method, params) =>
      method === "sessions.messages.subscribe" ? { key: params.key } : await unsubscribe.promise,
    );
    const coordinator = new GatewaySessionMessageSubscriptionCoordinator(client);
    const first = await coordinator.acquire("main");

    const release = coordinator.release(first);
    const replacement = coordinator.acquire("main");
    expect(request).toHaveBeenCalledTimes(2);

    unsubscribe.resolve({});
    await release;

    await expect(replacement).resolves.toEqual({ key: "main", agentId: null });
    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenNthCalledWith(3, "sessions.messages.subscribe", { key: "main" });
  });

  it("keeps approval observers upgraded when plain owners arrive later", async () => {
    const replay = { approvals: [{ id: "approval-1" }] };
    const { client, request } = createClient(async (method, params) =>
      method === "sessions.messages.subscribe"
        ? { key: params.key, ...(params.includeApprovals ? { approvalReplay: replay } : {}) }
        : {},
    );
    const coordinator = new GatewaySessionMessageSubscriptionCoordinator(client);

    const approvals = await coordinator.acquire("main", { includeApprovals: true });
    const plain = await coordinator.acquire("main");

    expect(approvals).toEqual({
      key: "main",
      agentId: null,
      includeApprovals: true,
      approvalReplay: replay,
    });
    expect(plain).toEqual({ key: "main", agentId: null });
    expect(request).toHaveBeenCalledExactlyOnceWith("sessions.messages.subscribe", {
      key: "main",
      includeApprovals: true,
    });

    await coordinator.release(approvals);
    expect(request).toHaveBeenCalledOnce();
    await coordinator.release(plain);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("upgrades an existing plain observer once and never downgrades approvals", async () => {
    const replay = { approvals: [{ id: "approval-2" }] };
    const { client, request } = createClient(async (method, params) =>
      method === "sessions.messages.subscribe"
        ? { key: params.key, ...(params.includeApprovals ? { approvalReplay: replay } : {}) }
        : {},
    );
    const coordinator = new GatewaySessionMessageSubscriptionCoordinator(client);

    const plain = await coordinator.acquire("main");
    const [firstApproval, secondApproval] = await Promise.all([
      coordinator.acquire("main", { includeApprovals: true }),
      coordinator.acquire("main", { includeApprovals: true }),
    ]);
    const laterPlain = await coordinator.acquire("main");

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1, "sessions.messages.subscribe", { key: "main" });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.messages.subscribe", {
      key: "main",
      includeApprovals: true,
    });
    expect(firstApproval.approvalReplay).toEqual(replay);
    expect(secondApproval.approvalReplay).toEqual(replay);

    await coordinator.release(firstApproval);
    await coordinator.release(secondApproval);
    await coordinator.release(plain);
    expect(request).toHaveBeenCalledTimes(2);
    await coordinator.release(laterPlain);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it.each([
    {
      name: "a closed approval pane leaves a plain observer",
      initialApprovals: false,
      closeFirst: true,
      before: ["approval-old"],
      after: [],
    },
    {
      name: "another pane joins an upgraded observer",
      initialApprovals: false,
      closeFirst: false,
      before: [],
      after: ["approval-new"],
    },
    {
      name: "another pane joins an initial approval observer",
      initialApprovals: true,
      closeFirst: false,
      before: ["approval-old"],
      after: ["approval-new"],
    },
  ])("refreshes pending approvals when $name", async (scenario) => {
    let replay = { approvals: scenario.before.map((id) => ({ id })) };
    const { client, request } = createClient(async (method, params) =>
      method === "sessions.messages.subscribe"
        ? { key: params.key, ...(params.includeApprovals ? { approvalReplay: replay } : {}) }
        : {},
    );
    const coordinator = new GatewaySessionMessageSubscriptionCoordinator(client);
    const retained = await coordinator.acquire("main", {
      includeApprovals: scenario.initialApprovals,
    });
    const first = scenario.initialApprovals
      ? retained
      : await coordinator.acquire("main", { includeApprovals: true });
    const handles = new Set([retained, first]);
    try {
      if (scenario.closeFirst) {
        await coordinator.release(first);
      }
      replay = { approvals: scenario.after.map((id) => ({ id })) };
      const next = await coordinator.acquire("main", { includeApprovals: true });
      handles.add(next);
      expect(next.approvalReplay).toEqual(replay);
    } finally {
      for (const handle of handles) {
        await coordinator.release(handle);
      }
    }
    expect(
      request.mock.calls.filter(([method]) => method === "sessions.messages.unsubscribe"),
    ).toHaveLength(1);
  });

  it.each(["none", "plain", "approvals"] as const)(
    "restores the %s owner's capability after an approval replay times out",
    async (retained) => {
      let capability: "none" | "plain" | "approvals" = "none";
      let timeoutNext = false;
      const timeout = new GatewayProtocolRequestTimeoutError({
        method: "sessions.messages.subscribe",
        timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
        requestSent: true,
      });
      const { client } = createClient(async (method, params) => {
        capability =
          method === "sessions.messages.unsubscribe"
            ? "none"
            : params.includeApprovals
              ? "approvals"
              : "plain";
        if (timeoutNext) {
          timeoutNext = false;
          throw timeout;
        }
        return { key: params.key, approvalReplay: { approvals: [] } };
      });
      const coordinator = new GatewaySessionMessageSubscriptionCoordinator(client);
      const owner =
        retained === "none"
          ? null
          : await coordinator.acquire("main", { includeApprovals: retained === "approvals" });
      try {
        timeoutNext = true;
        await expect(coordinator.acquire("main", { includeApprovals: true })).rejects.toBe(timeout);
        expect(capability).toBe(retained);
      } finally {
        if (owner) {
          await coordinator.release(owner);
        }
      }
      expect(capability).toBe("none");
    },
  );

  it("preserves the plain observer when an approval upgrade is unauthorized", async () => {
    let rejectApproval = true;
    const { client, request } = createClient(async (method, params) => {
      if (method === "sessions.messages.unsubscribe") {
        return {};
      }
      if (params.includeApprovals && rejectApproval) {
        throw new Error("operator.approvals scope required");
      }
      return {
        key: params.key,
        ...(params.includeApprovals ? { approvalReplay: { approvals: [] } } : {}),
      };
    });
    const coordinator = new GatewaySessionMessageSubscriptionCoordinator(client);
    const plain = await coordinator.acquire("main");

    await expect(coordinator.acquire("main", { includeApprovals: true })).rejects.toThrow(
      "operator.approvals scope required",
    );
    expect(request).toHaveBeenCalledTimes(2);

    const anotherPlain = await coordinator.acquire("main");
    expect(request).toHaveBeenCalledTimes(2);

    rejectApproval = false;
    await expect(coordinator.acquire("main", { includeApprovals: true })).resolves.toMatchObject({
      includeApprovals: true,
      approvalReplay: { approvals: [] },
    });
    expect(request).toHaveBeenCalledTimes(3);
    await coordinator.release(plain);
    await coordinator.release(anotherPlain);
  });

  it("lets concurrent plain observers recover when the first approval request is unauthorized", async () => {
    const approval = createDeferred<unknown>();
    const { client, request } = createClient(async (method, params) => {
      if (method === "sessions.messages.unsubscribe") {
        return {};
      }
      if (params.includeApprovals) {
        return await approval.promise;
      }
      return { key: params.key };
    });
    const coordinator = new GatewaySessionMessageSubscriptionCoordinator(client);

    const denied = coordinator.acquire("main", { includeApprovals: true });
    const firstPlain = coordinator.acquire("main");
    const secondPlain = coordinator.acquire("main");
    approval.reject(new Error("operator.approvals scope required"));

    await expect(denied).rejects.toThrow("operator.approvals scope required");
    await expect(Promise.all([firstPlain, secondPlain])).resolves.toEqual([
      { key: "main", agentId: null },
      { key: "main", agentId: null },
    ]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1, "sessions.messages.subscribe", {
      key: "main",
      includeApprovals: true,
    });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.messages.subscribe", { key: "main" });
  });

  it("releases the last plain owner after its provisional approval upgrade fails", async () => {
    const approval = createDeferred<unknown>();
    const { client, request } = createClient(async (method, params) => {
      if (method === "sessions.messages.unsubscribe") {
        return {};
      }
      if (params.includeApprovals) {
        return await approval.promise;
      }
      return { key: params.key };
    });
    const coordinator = new GatewaySessionMessageSubscriptionCoordinator(client);
    const plain = await coordinator.acquire("main");

    const pendingApproval = coordinator.acquire("main", { includeApprovals: true });
    void pendingApproval.catch(() => undefined);
    await Promise.resolve();
    const release = coordinator.release(plain);

    approval.reject(new Error("approval replay unavailable"));
    await expect(pendingApproval).rejects.toThrow("approval replay unavailable");
    await expect(release).resolves.toBeUndefined();
    expect(request).toHaveBeenLastCalledWith("sessions.messages.unsubscribe", { key: "main" });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("isolates the same global key by canonical agent", async () => {
    const { client, request } = createClient();
    const coordinator = new GatewaySessionMessageSubscriptionCoordinator(client);

    const [main, research] = await Promise.all([
      coordinator.acquire("global", { agentId: "main" }),
      coordinator.acquire("global", { agentId: "research" }),
    ]);

    expect(main).toEqual({ key: "global", agentId: "main" });
    expect(research).toEqual({ key: "global", agentId: "research" });
    expect(request).toHaveBeenNthCalledWith(1, "sessions.messages.subscribe", {
      key: "global",
      agentId: "main",
    });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.messages.subscribe", {
      key: "global",
      agentId: "research",
    });
  });

  it("retries an initial subscribe without retaining a failed observer", async () => {
    let calls = 0;
    const { client, request } = createClient(async (_method, params) => {
      calls += 1;
      if (calls === 1) {
        throw new Error("temporary subscribe failure");
      }
      return { key: params.key };
    });
    const coordinator = new GatewaySessionMessageSubscriptionCoordinator(client);

    await expect(coordinator.acquire("main")).rejects.toThrow("temporary subscribe failure");
    await expect(coordinator.acquire("main")).resolves.toEqual({ key: "main", agentId: null });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("retires an old generation without unsubscribing a replacement connection", async () => {
    const { client, request } = createClient();
    const firstCoordinator = getGatewaySessionMessageSubscriptionCoordinator(client);
    const oldLease = await firstCoordinator.acquire("main");

    resetGatewaySessionMessageSubscriptionCoordinator(client);

    const nextCoordinator = getGatewaySessionMessageSubscriptionCoordinator(client);
    expect(nextCoordinator).not.toBe(firstCoordinator);
    const replacement = await nextCoordinator.acquire("main");
    await expect(releaseGatewaySessionMessageSubscription(oldLease)).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);

    await releaseGatewaySessionMessageSubscription(replacement);
    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenLastCalledWith("sessions.messages.unsubscribe", { key: "main" });
  });

  it("rejects a subscribe acknowledgment from a retired connection", async () => {
    const response = createDeferred<unknown>();
    const { client, request } = createClient(async () => await response.promise);
    const coordinator = getGatewaySessionMessageSubscriptionCoordinator(client);
    const pending = coordinator.acquire("main");

    resetGatewaySessionMessageSubscriptionCoordinator(client);
    response.resolve({ key: "main" });

    await expect(pending).rejects.toThrow("replaced Gateway connection");
    expect(request).toHaveBeenCalledOnce();
  });

  it("shares canonical lease ownership across clients of the same connection", async () => {
    const { client, request } = createClient();
    const firstCoordinator = getGatewaySessionMessageSubscriptionCoordinator(client);
    const secondCoordinator = getGatewaySessionMessageSubscriptionCoordinator(client);

    expect(firstCoordinator).toBe(secondCoordinator);
    const first = await firstCoordinator.acquire("main");
    const second = await secondCoordinator.acquire("main");
    expect(request).toHaveBeenCalledOnce();

    await releaseGatewaySessionMessageSubscription(first);
    expect(request).toHaveBeenCalledOnce();
    await releaseGatewaySessionMessageSubscription(second);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("configures a cached coordinator before sharing UI session aliases", async () => {
    const { client, request } = createClient(async (method) =>
      method === "sessions.messages.subscribe" ? { key: "agent:main:main" } : {},
    );
    const cached = getGatewaySessionMessageSubscriptionCoordinator(client);
    const keysEquivalent = (left: string, right: string) =>
      left.toLowerCase() === right.toLowerCase();
    const configured = getGatewaySessionMessageSubscriptionCoordinator(client, {
      keysEquivalent,
    });

    expect(configured).toBe(cached);
    const first = await configured.acquire("MAIN");
    const second = await getGatewaySessionMessageSubscriptionCoordinator(client, {
      keysEquivalent,
    }).acquire("main");

    expect(request).toHaveBeenCalledExactlyOnceWith("sessions.messages.subscribe", {
      key: "MAIN",
    });
    expect(first.key).toBe("agent:main:main");
    expect(second.key).toBe("agent:main:main");
    expect(() =>
      getGatewaySessionMessageSubscriptionCoordinator(client, {
        keysEquivalent: (left, right) => left === right,
      }),
    ).toThrow("key equivalence cannot change for an active connection");

    await releaseGatewaySessionMessageSubscription(first);
    expect(request).toHaveBeenCalledOnce();
    await releaseGatewaySessionMessageSubscription(second);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith("sessions.messages.unsubscribe", {
      key: "agent:main:main",
    });
  });
});
