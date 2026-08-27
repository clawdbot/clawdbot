import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import { createClientHarness } from "./test-support.js";

const EXPECTED_LIVE_THREAD_IDLE_TIMEOUT_MS = 30 * 60_000;
const EXPECTED_MAX_IDLE_LIVE_THREADS = 64;

const mocks = vi.hoisted(() => ({
  refreshAuth: vi.fn(async (_params?: { authProfileStore?: unknown }) => ({
    accessToken: "refreshed",
    chatgptAccountId: "account",
  })),
  mergeRateLimitUpdate: vi.fn(),
}));

vi.mock("./auth-bridge.js", () => ({
  refreshCodexAppServerAuthTokens: mocks.refreshAuth,
}));

vi.mock("./rate-limit-cache.js", () => ({
  mergeCodexRateLimitsUpdate: mocks.mergeRateLimitUpdate,
}));

const {
  claimCodexAppServerLiveThread,
  consumeCodexAppServerLiveThread,
  ensureCodexAppServerClientRuntime,
  hasCodexAppServerLiveThread,
  isCodexAppServerLiveThreadClaimed,
  protectCodexAppServerLiveThread,
  releaseCodexAppServerLiveThread,
  retainCodexAppServerLiveThread,
  unsubscribeCodexAppServerLiveThread,
} = await import("./client-runtime.js");

describe("Codex app-server client runtime", () => {
  const clients: CodexAppServerClient[] = [];

  afterEach(() => {
    for (const client of clients) {
      client.close();
    }
    clients.length = 0;
    vi.useRealTimers();
    mocks.refreshAuth.mockClear();
    mocks.mergeRateLimitUpdate.mockClear();
  });

  it("installs shared handlers once per physical client", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    const context = {
      agentDir: "/tmp/agent",
      authProfileId: "openai:default",
      config: {},
    };
    const updatedContext = {
      ...context,
      authProfileStore: { version: 1 as const, profiles: {} },
      config: { models: { mode: "merge" as const } },
    };
    const addNotificationHandler = vi.spyOn(harness.client, "addNotificationHandler");
    const addRequestHandler = vi.spyOn(harness.client, "addRequestHandler");
    const addCloseHandler = vi.spyOn(harness.client, "addCloseHandler");

    ensureCodexAppServerClientRuntime(harness.client, context);
    ensureCodexAppServerClientRuntime(harness.client, updatedContext);

    expect(addNotificationHandler).toHaveBeenCalledTimes(1);
    expect(addRequestHandler).toHaveBeenCalledTimes(1);
    expect(addCloseHandler).toHaveBeenCalledTimes(1);
    harness.send({
      method: "account/rateLimits/updated",
      params: { rateLimits: { primary: { usedPercent: 12 } } },
    });
    harness.send({
      id: "refresh-1",
      method: "account/chatgptAuthTokens/refresh",
      params: { reason: "expired" },
    });

    await vi.waitFor(() => expect(mocks.mergeRateLimitUpdate).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(mocks.refreshAuth).toHaveBeenCalledTimes(1));
    expect(mocks.refreshAuth).toHaveBeenCalledWith({
      ...context,
      config: updatedContext.config,
    });
    expect(mocks.mergeRateLimitUpdate).toHaveBeenCalledWith(harness.client, {
      rateLimits: { primary: { usedPercent: 12 } },
    });
    await vi.waitFor(() =>
      expect(harness.writes.map((line) => JSON.parse(line) as unknown)).toContainEqual({
        id: "refresh-1",
        result: { accessToken: "refreshed", chatgptAccountId: "account" },
      }),
    );
  });

  it("rejects ChatGPT refresh on a prepared API-key client", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    ensureCodexAppServerClientRuntime(harness.client, {
      agentDir: "/tmp/agent",
      authMode: "prepared-api-key",
    });

    harness.send({
      id: "refresh-api-key",
      method: "account/chatgptAuthTokens/refresh",
      params: { reason: "expired" },
    });

    await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThan(0));
    expect(mocks.refreshAuth).not.toHaveBeenCalled();
    expect(JSON.parse(harness.writes.at(-1) ?? "{}")).toMatchObject({
      id: "refresh-api-key",
      error: {
        message: "ChatGPT token refresh is unavailable for prepared Codex API-key auth.",
      },
    });
  });

  it("bounds token refresh at the Codex external-auth request boundary", async () => {
    vi.useFakeTimers();
    mocks.refreshAuth.mockImplementationOnce(() => new Promise(() => {}));
    const harness = createClientHarness();
    clients.push(harness.client);
    ensureCodexAppServerClientRuntime(harness.client, { agentDir: "/tmp/agent" });

    harness.send({
      id: "refresh-timed-out",
      method: "account/chatgptAuthTokens/refresh",
      params: { reason: "expired" },
    });

    await vi.advanceTimersByTimeAsync(8_999);
    expect(harness.writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(JSON.parse(harness.writes.at(-1) ?? "{}")).toMatchObject({
      id: "refresh-timed-out",
      error: { message: expect.stringContaining("token refresh timed out") },
    });
  });

  it("rejects a refreshed token from a different ChatGPT workspace", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    ensureCodexAppServerClientRuntime(harness.client, {
      agentDir: "/tmp/agent",
      authProfileId: "openai:default",
    });

    harness.send({
      id: "refresh-other-workspace",
      method: "account/chatgptAuthTokens/refresh",
      params: { reason: "unauthorized", previousAccountId: "original-workspace" },
    });

    await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThan(0));
    expect(JSON.parse(harness.writes.at(-1) ?? "{}")).toMatchObject({
      id: "refresh-other-workspace",
      error: { message: expect.stringContaining("ChatGPT workspace changed") },
    });
  });

  it("keeps the physical client's original auth store across later leases", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    const originalStore = { version: 1 as const, profiles: {} };
    const replacementStore = { version: 1 as const, profiles: {} };
    ensureCodexAppServerClientRuntime(harness.client, {
      agentDir: "/tmp/agent",
      authProfileId: "openai:default",
      authProfileStore: originalStore,
    });
    ensureCodexAppServerClientRuntime(harness.client, {
      agentDir: "/tmp/agent",
      authProfileId: "openai:default",
      authProfileStore: replacementStore,
      config: { models: { mode: "merge" } },
    });

    harness.send({
      id: "refresh-original-owner",
      method: "account/chatgptAuthTokens/refresh",
      params: { reason: "unauthorized", previousAccountId: "account" },
    });

    await vi.waitFor(() => expect(mocks.refreshAuth).toHaveBeenCalledOnce());
    expect(mocks.refreshAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        authProfileStore: originalStore,
        previousAccountId: "account",
      }),
    );
    expect(mocks.refreshAuth.mock.calls[0]?.[0]?.authProfileStore).toBe(originalStore);
  });

  it("retains independently subscribed conversations on the same physical client", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);

    await expect(
      retainCodexAppServerLiveThread(harness.client, "thread-before-runtime"),
    ).resolves.toBe(false);
    ensureCodexAppServerClientRuntime(harness.client, { agentDir: "/tmp/agent" });

    await expect(retainCodexAppServerLiveThread(harness.client, "thread-a")).resolves.toBe(true);
    await expect(retainCodexAppServerLiveThread(harness.client, "thread-b")).resolves.toBe(true);
    await expect(consumeCodexAppServerLiveThread(harness.client, "thread-a")).resolves.toEqual(
      expect.objectContaining({ release: expect.any(Function) }),
    );
    await expect(consumeCodexAppServerLiveThread(harness.client, "thread-b")).resolves.toEqual(
      expect.objectContaining({ release: expect.any(Function) }),
    );
    await expect(
      consumeCodexAppServerLiveThread(harness.client, "thread-a"),
    ).resolves.toBeUndefined();
  });

  it("claims a fresh auto-subscribed child without exposing or evicting an idle owner", async () => {
    const request = vi.fn(async () => ({}));
    const client = {
      request,
      addCloseHandler: vi.fn(),
      addNotificationHandler: vi.fn(),
      addRequestHandler: vi.fn(),
    } as unknown as CodexAppServerClient;
    ensureCodexAppServerClientRuntime(client, { agentDir: "/tmp/agent" });
    const idleRelease = vi.fn(async () => undefined);
    for (let index = 0; index < EXPECTED_MAX_IDLE_LIVE_THREADS; index += 1) {
      await retainCodexAppServerLiveThread(client, `thread-idle-${index}`, idleRelease);
    }

    const ownership = await claimCodexAppServerLiveThread(client, "thread-fresh-child");

    expect(ownership).toEqual(expect.objectContaining({ release: expect.any(Function) }));
    expect(isCodexAppServerLiveThreadClaimed(client, "thread-fresh-child")).toBe(true);
    expect(idleRelease).not.toHaveBeenCalled();
    await expect(
      claimCodexAppServerLiveThread(client, "thread-fresh-child"),
    ).resolves.toBeUndefined();
    await expect(retainCodexAppServerLiveThread(client, "thread-fresh-child")).resolves.toBe(false);
    await expect(
      consumeCodexAppServerLiveThread(client, "thread-fresh-child"),
    ).resolves.toBeUndefined();
    await ownership?.release("thread-fresh-child");

    expect(request).toHaveBeenCalledExactlyOnceWith(
      "thread/unsubscribe",
      { threadId: "thread-fresh-child" },
      { timeoutMs: 5_000 },
    );
    expect(isCodexAppServerLiveThreadClaimed(client, "thread-fresh-child")).toBe(false);
    expect(idleRelease).not.toHaveBeenCalled();
  });

  it("keeps an active claim until its exact ownership is successfully released", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    ensureCodexAppServerClientRuntime(harness.client, { agentDir: "/tmp/agent" });
    const release = vi
      .fn<(threadId: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("unsubscribe unavailable"))
      .mockResolvedValueOnce(undefined);
    await retainCodexAppServerLiveThread(harness.client, "thread-claimed", release);
    const ownership = await consumeCodexAppServerLiveThread(harness.client, "thread-claimed");

    expect(isCodexAppServerLiveThreadClaimed(harness.client, "thread-claimed")).toBe(true);
    await expect(ownership?.release("thread-claimed")).rejects.toThrow("unsubscribe unavailable");
    expect(isCodexAppServerLiveThreadClaimed(harness.client, "thread-claimed")).toBe(true);
    await expect(ownership?.release("thread-claimed")).resolves.toBeUndefined();
    expect(isCodexAppServerLiveThreadClaimed(harness.client, "thread-claimed")).toBe(false);
  });

  it("rejects unproven or stale ownership before transferring an active claim", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    ensureCodexAppServerClientRuntime(harness.client, { agentDir: "/tmp/agent" });
    await retainCodexAppServerLiveThread(harness.client, "thread-owned");
    const current = await consumeCodexAppServerLiveThread(harness.client, "thread-owned");

    await expect(retainCodexAppServerLiveThread(harness.client, "thread-owned")).resolves.toBe(
      false,
    );
    await expect(
      retainCodexAppServerLiveThread(harness.client, "thread-owned", async () => undefined),
    ).resolves.toBe(false);
    expect(isCodexAppServerLiveThreadClaimed(harness.client, "thread-owned")).toBe(true);
    await expect(
      consumeCodexAppServerLiveThread(harness.client, "thread-owned"),
    ).resolves.toBeUndefined();
    await expect(
      retainCodexAppServerLiveThread(harness.client, "thread-owned", current?.release),
    ).resolves.toBe(true);
    const successor = await consumeCodexAppServerLiveThread(harness.client, "thread-owned");

    await expect(
      retainCodexAppServerLiveThread(harness.client, "thread-owned", current?.release),
    ).resolves.toBe(false);
    expect(isCodexAppServerLiveThreadClaimed(harness.client, "thread-owned")).toBe(true);
    await expect(
      retainCodexAppServerLiveThread(harness.client, "thread-owned", successor?.release),
    ).resolves.toBe(true);
  });

  it("does not let an older release erase a newly claimed thread generation", async () => {
    const request = vi.fn(async () => ({}));
    const client = {
      request,
      addCloseHandler: vi.fn(),
      addNotificationHandler: vi.fn(),
      addRequestHandler: vi.fn(),
    } as unknown as CodexAppServerClient;
    ensureCodexAppServerClientRuntime(client, { agentDir: "/tmp/agent" });
    await retainCodexAppServerLiveThread(client, "thread-reclaimed");
    const first = await consumeCodexAppServerLiveThread(client, "thread-reclaimed");
    await retainCodexAppServerLiveThread(client, "thread-reclaimed", first?.release);
    expect(isCodexAppServerLiveThreadClaimed(client, "thread-reclaimed")).toBe(false);
    const second = await consumeCodexAppServerLiveThread(client, "thread-reclaimed");

    await first?.release("thread-reclaimed");

    expect(request).not.toHaveBeenCalled();
    expect(isCodexAppServerLiveThreadClaimed(client, "thread-reclaimed")).toBe(true);
    await second?.release("thread-reclaimed");
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "thread/unsubscribe",
      { threadId: "thread-reclaimed" },
      { timeoutMs: 5_000 },
    );
    expect(isCodexAppServerLiveThreadClaimed(client, "thread-reclaimed")).toBe(false);
  });

  it.each([
    { claimed: true, unpinDuringRelease: false },
    { claimed: false, unpinDuringRelease: false },
    { claimed: false, unpinDuringRelease: true },
  ])(
    "blocks same-thread replacement until unsubscribe is acknowledged (claimed: $claimed, unpin: $unpinDuringRelease)",
    async ({ claimed, unpinDuringRelease }) => {
      let acknowledgeUnsubscribe: (() => void) | undefined;
      const unsubscribeAcknowledged = new Promise<void>((resolve) => {
        acknowledgeUnsubscribe = resolve;
      });
      const request = vi.fn(async (method: string) => {
        if (method === "thread/unsubscribe") {
          await unsubscribeAcknowledged;
        }
        return {};
      });
      const client = {
        request,
        addCloseHandler: vi.fn(),
        addNotificationHandler: vi.fn(),
        addRequestHandler: vi.fn(),
      } as unknown as CodexAppServerClient;
      ensureCodexAppServerClientRuntime(client, { agentDir: "/tmp/agent" });
      const unprotect = unpinDuringRelease
        ? protectCodexAppServerLiveThread(client, "thread-transition")
        : undefined;
      await retainCodexAppServerLiveThread(client, "thread-transition");
      const previous = claimed
        ? await consumeCodexAppServerLiveThread(client, "thread-transition")
        : undefined;
      const release = () =>
        previous
          ? previous.release("thread-transition")
          : unsubscribeCodexAppServerLiveThread(client, "thread-transition", 5_000);
      const releasing = release();
      const duplicateRelease = release();
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      unprotect?.();
      const overlappingPhysicalRelease = unsubscribeCodexAppServerLiveThread(
        client,
        "thread-transition",
        5_000,
      );
      await Promise.resolve();
      expect(request).toHaveBeenCalledOnce();
      const replacement = retainCodexAppServerLiveThread(
        client,
        "thread-transition",
        previous?.release,
      );
      const blockedClaim = consumeCodexAppServerLiveThread(client, "thread-transition");
      let replacementPublished = false;
      void replacement.then(() => {
        replacementPublished = true;
      });
      await Promise.resolve();

      expect(replacementPublished).toBe(false);
      expect(isCodexAppServerLiveThreadClaimed(client, "thread-transition")).toBe(claimed);
      acknowledgeUnsubscribe?.();

      await expect(releasing).resolves.toBeUndefined();
      await expect(duplicateRelease).resolves.toBeUndefined();
      await expect(overlappingPhysicalRelease).resolves.toBeUndefined();
      await expect(replacement).resolves.toBe(false);
      await expect(blockedClaim).resolves.toBeUndefined();
      await client.request(
        "thread/resume",
        { threadId: "thread-transition" },
        { timeoutMs: 5_000 },
      );
      await expect(
        retainCodexAppServerLiveThread(client, "thread-transition", previous?.release),
      ).resolves.toBe(true);
      const successor = await consumeCodexAppServerLiveThread(client, "thread-transition");
      await successor?.release("thread-transition");
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "thread/unsubscribe",
        "thread/resume",
        "thread/unsubscribe",
      ]);
    },
  );

  it.each([false, true])(
    "finishes a thread when its direct physical unsubscribe succeeds (claimed: %s)",
    async (claimed) => {
      const request = vi.fn(async () => ({}));
      request.mockRejectedValueOnce(new Error("unsubscribe unavailable"));
      const client = {
        request,
        addCloseHandler: vi.fn(),
        addNotificationHandler: vi.fn(),
        addRequestHandler: vi.fn(),
      } as unknown as CodexAppServerClient;
      ensureCodexAppServerClientRuntime(client, { agentDir: "/tmp/agent" });
      await retainCodexAppServerLiveThread(client, "thread-direct");
      if (claimed) {
        await consumeCodexAppServerLiveThread(client, "thread-direct");
      }

      const failedRelease = unsubscribeCodexAppServerLiveThread(client, "thread-direct", 5_000);
      const failedJoin = unsubscribeCodexAppServerLiveThread(client, "thread-direct", 5_000);
      await expect(Promise.all([failedRelease, failedJoin])).rejects.toThrow(
        "unsubscribe unavailable",
      );
      expect(request).toHaveBeenCalledOnce();
      expect(hasCodexAppServerLiveThread(client, "thread-direct")).toBe(true);
      await unsubscribeCodexAppServerLiveThread(client, "thread-direct", 5_000);

      expect(request).toHaveBeenLastCalledWith(
        "thread/unsubscribe",
        { threadId: "thread-direct" },
        { timeoutMs: 5_000 },
      );
      expect(hasCodexAppServerLiveThread(client, "thread-direct")).toBe(false);
    },
  );

  it("clears claimed ownership when Codex closes the thread or its physical client", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    ensureCodexAppServerClientRuntime(harness.client, { agentDir: "/tmp/agent" });
    await retainCodexAppServerLiveThread(harness.client, "thread-closed");
    await consumeCodexAppServerLiveThread(harness.client, "thread-closed");

    harness.send({ method: "thread/closed", params: { threadId: "thread-closed" } });

    await vi.waitFor(() =>
      expect(isCodexAppServerLiveThreadClaimed(harness.client, "thread-closed")).toBe(false),
    );
    await retainCodexAppServerLiveThread(harness.client, "thread-client-closed");
    await consumeCodexAppServerLiveThread(harness.client, "thread-client-closed");
    expect(isCodexAppServerLiveThreadClaimed(harness.client, "thread-client-closed")).toBe(true);

    harness.client.close();

    expect(isCodexAppServerLiveThreadClaimed(harness.client, "thread-client-closed")).toBe(false);
  });

  it("blocks only the exact thread whose subscription is being released", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    ensureCodexAppServerClientRuntime(harness.client, { agentDir: "/tmp/agent" });

    let finishRelease: (() => void) | undefined;
    const pendingRelease = new Promise<void>((resolve) => {
      finishRelease = resolve;
    });
    await retainCodexAppServerLiveThread(harness.client, "thread-a", async () => pendingRelease);
    await retainCodexAppServerLiveThread(harness.client, "thread-b");
    const release = releaseCodexAppServerLiveThread(harness.client, "thread-a");
    const sameThreadAcquisition = consumeCodexAppServerLiveThread(harness.client, "thread-a");

    await expect(consumeCodexAppServerLiveThread(harness.client, "thread-b")).resolves.toEqual(
      expect.objectContaining({ release: expect.any(Function) }),
    );
    finishRelease?.();
    await expect(release).resolves.toBe(true);
    await expect(sameThreadAcquisition).resolves.toBeUndefined();
  });

  it("preserves a failed idle release and its unrelated conversation for retry", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    ensureCodexAppServerClientRuntime(harness.client, { agentDir: "/tmp/agent" });
    await retainCodexAppServerLiveThread(harness.client, "thread-a", async () => {
      throw new Error("unsubscribe unavailable");
    });
    await retainCodexAppServerLiveThread(harness.client, "thread-b");

    await expect(releaseCodexAppServerLiveThread(harness.client, "thread-a")).rejects.toThrow(
      "unsubscribe unavailable",
    );
    await expect(consumeCodexAppServerLiveThread(harness.client, "thread-a")).resolves.toEqual(
      expect.objectContaining({ release: expect.any(Function) }),
    );
    await expect(consumeCodexAppServerLiveThread(harness.client, "thread-b")).resolves.toEqual(
      expect.objectContaining({ release: expect.any(Function) }),
    );
  });

  it("rechecks deletion authority before sending the physical unsubscribe", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    ensureCodexAppServerClientRuntime(harness.client, { agentDir: "/tmp/agent" });
    await retainCodexAppServerLiveThread(harness.client, "thread-deleted");
    const request = vi.spyOn(harness.client, "request");
    let current = true;
    const release = releaseCodexAppServerLiveThread(harness.client, "thread-deleted", () => {
      if (!current) {
        throw new Error("deletion owner closed");
      }
    });
    current = false;
    await expect(release).rejects.toThrow("deletion owner closed");
    expect(request).not.toHaveBeenCalled();
    await expect(
      consumeCodexAppServerLiveThread(harness.client, "thread-deleted"),
    ).resolves.toEqual(expect.objectContaining({ release: expect.any(Function) }));
  });

  it("transfers ownership only for the exact immutable thread fingerprint", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    ensureCodexAppServerClientRuntime(harness.client, { agentDir: "/tmp/agent" });

    await expect(
      retainCodexAppServerLiveThread(harness.client, "thread-1", undefined, "config-before"),
    ).resolves.toBe(true);
    await expect(
      consumeCodexAppServerLiveThread(harness.client, "thread-1", "config-after"),
    ).resolves.toBeUndefined();
    await expect(
      consumeCodexAppServerLiveThread(harness.client, "thread-1", "config-before"),
    ).resolves.toEqual(
      expect.objectContaining({
        configFingerprint: "config-before",
        release: expect.any(Function),
      }),
    );
  });

  it("evicts only the oldest idle subscription at the per-client capacity", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    ensureCodexAppServerClientRuntime(harness.client, { agentDir: "/tmp/agent" });
    const release = vi.fn(async (_threadId: string) => undefined);

    for (let index = 0; index <= EXPECTED_MAX_IDLE_LIVE_THREADS; index += 1) {
      await retainCodexAppServerLiveThread(harness.client, `thread-${index}`, release);
    }

    expect(release).toHaveBeenCalledExactlyOnceWith("thread-0");
    const retained = await consumeCodexAppServerLiveThread(harness.client, "thread-1");
    expect(retained).toEqual(expect.objectContaining({ release: expect.any(Function) }));
    await retained?.release("thread-1");
    expect(release).toHaveBeenLastCalledWith("thread-1");
  });

  it("rolls back the new owner when capacity eviction cannot release its oldest thread", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    ensureCodexAppServerClientRuntime(harness.client, { agentDir: "/tmp/agent" });
    const failingRelease = vi
      .fn<(threadId: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("oldest unsubscribe failed"))
      .mockResolvedValueOnce(undefined);
    await retainCodexAppServerLiveThread(harness.client, "thread-oldest", failingRelease);
    for (let index = 1; index < EXPECTED_MAX_IDLE_LIVE_THREADS; index += 1) {
      await retainCodexAppServerLiveThread(harness.client, `thread-${index}`);
    }

    await expect(retainCodexAppServerLiveThread(harness.client, "thread-overflow")).resolves.toBe(
      false,
    );
    expect(failingRelease).toHaveBeenCalledOnce();
    await expect(
      consumeCodexAppServerLiveThread(harness.client, "thread-overflow"),
    ).resolves.toBeUndefined();
    await expect(consumeCodexAppServerLiveThread(harness.client, "thread-1")).resolves.toEqual(
      expect.objectContaining({ release: expect.any(Function) }),
    );
    await expect(releaseCodexAppServerLiveThread(harness.client, "thread-oldest")).resolves.toBe(
      true,
    );
    expect(failingRelease).toHaveBeenCalledTimes(2);
  });

  it("cannot resurrect an overflow owner after the physical client closes during eviction", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    ensureCodexAppServerClientRuntime(harness.client, { agentDir: "/tmp/agent" });
    let finishRelease: (() => void) | undefined;
    const pendingRelease = new Promise<void>((resolve) => {
      finishRelease = resolve;
    });
    await retainCodexAppServerLiveThread(
      harness.client,
      "thread-oldest",
      async () => pendingRelease,
    );
    for (let index = 1; index < EXPECTED_MAX_IDLE_LIVE_THREADS; index += 1) {
      await retainCodexAppServerLiveThread(harness.client, `thread-${index}`);
    }
    const retain = retainCodexAppServerLiveThread(harness.client, "thread-overflow");

    harness.client.close();
    finishRelease?.();

    await expect(retain).resolves.toBe(false);
    await expect(
      consumeCodexAppServerLiveThread(harness.client, "thread-overflow"),
    ).resolves.toBeUndefined();
  });

  it("expires an idle subscription without keeping the process alive", async () => {
    vi.useFakeTimers();
    const harness = createClientHarness();
    clients.push(harness.client);
    ensureCodexAppServerClientRuntime(harness.client, { agentDir: "/tmp/agent" });
    const release = vi.fn(async (_threadId: string) => undefined);
    await retainCodexAppServerLiveThread(harness.client, "thread-expired", release);

    await vi.advanceTimersByTimeAsync(EXPECTED_LIVE_THREAD_IDLE_TIMEOUT_MS - 1);
    expect(release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(release).toHaveBeenCalledExactlyOnceWith("thread-expired");
  });

  it("renews a failed expiry instead of spinning and retries the same native owner", async () => {
    vi.useFakeTimers();
    const harness = createClientHarness();
    clients.push(harness.client);
    ensureCodexAppServerClientRuntime(harness.client, { agentDir: "/tmp/agent" });
    const release = vi
      .fn<(threadId: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("temporary unsubscribe failure"))
      .mockResolvedValueOnce(undefined);
    await retainCodexAppServerLiveThread(harness.client, "thread-expiry-retry", release);

    await vi.advanceTimersByTimeAsync(EXPECTED_LIVE_THREAD_IDLE_TIMEOUT_MS);

    expect(release).toHaveBeenCalledExactlyOnceWith("thread-expiry-retry");
    await vi.advanceTimersByTimeAsync(EXPECTED_LIVE_THREAD_IDLE_TIMEOUT_MS - 1);
    expect(release).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);

    expect(release).toHaveBeenCalledTimes(2);
    await expect(
      consumeCodexAppServerLiveThread(harness.client, "thread-expiry-retry"),
    ).resolves.toBeUndefined();
  });

  it("never resurrects a natively closed thread after its in-flight unsubscribe fails", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    ensureCodexAppServerClientRuntime(harness.client, { agentDir: "/tmp/agent" });
    let rejectUnsubscribe: ((error: Error) => void) | undefined;
    const failedUnsubscribe = new Promise<void>((_resolve, reject) => {
      rejectUnsubscribe = reject;
    });
    const release = vi.fn(async () => await failedUnsubscribe);
    await retainCodexAppServerLiveThread(harness.client, "thread-terminal", release);
    const notificationObserved = new Promise<void>((resolve) => {
      harness.client.addNotificationHandler((notification) => {
        if (notification.method === "thread/closed") {
          resolve();
        }
      });
    });
    const releasing = releaseCodexAppServerLiveThread(harness.client, "thread-terminal");
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());

    harness.send({ method: "thread/closed", params: { threadId: "thread-terminal" } });
    await notificationObserved;
    rejectUnsubscribe?.(new Error("client closed before unsubscribe completed"));

    await expect(releasing).rejects.toThrow("client closed before unsubscribe completed");
    await expect(
      consumeCodexAppServerLiveThread(harness.client, "thread-terminal"),
    ).resolves.toBeUndefined();
  });

  it("protects native-child parents and renews their idle clock after the final child", async () => {
    vi.useFakeTimers();
    const harness = createClientHarness();
    clients.push(harness.client);
    ensureCodexAppServerClientRuntime(harness.client, { agentDir: "/tmp/agent" });
    const release = vi.fn(async (_threadId: string) => undefined);
    const unprotect = protectCodexAppServerLiveThread(harness.client, "thread-parent");
    await retainCodexAppServerLiveThread(harness.client, "thread-parent", release);

    await vi.advanceTimersByTimeAsync(EXPECTED_LIVE_THREAD_IDLE_TIMEOUT_MS * 2);
    expect(release).not.toHaveBeenCalled();
    unprotect();
    await vi.advanceTimersByTimeAsync(EXPECTED_LIVE_THREAD_IDLE_TIMEOUT_MS - 1);
    expect(release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(release).toHaveBeenCalledExactlyOnceWith("thread-parent");
  });

  it("keeps protected parents outside the independent idle-conversation limit", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    ensureCodexAppServerClientRuntime(harness.client, { agentDir: "/tmp/agent" });
    const release = vi.fn(async (_threadId: string) => undefined);
    const unprotect: Array<() => void> = [];
    for (let index = 0; index < EXPECTED_MAX_IDLE_LIVE_THREADS; index += 1) {
      const threadId = `parent-${index}`;
      unprotect.push(protectCodexAppServerLiveThread(harness.client, threadId));
      await retainCodexAppServerLiveThread(harness.client, threadId, release);
    }
    await retainCodexAppServerLiveThread(harness.client, "conversation-a", release);
    await retainCodexAppServerLiveThread(harness.client, "conversation-b", release);

    expect(release).not.toHaveBeenCalled();
    for (const releaseProtection of unprotect) {
      releaseProtection();
    }
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(2));
    expect(release).toHaveBeenNthCalledWith(1, "conversation-a");
    expect(release).toHaveBeenNthCalledWith(2, "conversation-b");
  });

  it("keeps a failed unpin eviction owned until its original subscription can be retried", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    ensureCodexAppServerClientRuntime(harness.client, { agentDir: "/tmp/agent" });
    const release = vi
      .fn<(threadId: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("temporary unpin unsubscribe failure"))
      .mockResolvedValueOnce(undefined);
    await retainCodexAppServerLiveThread(harness.client, "thread-oldest", release);
    for (let index = 1; index < EXPECTED_MAX_IDLE_LIVE_THREADS; index += 1) {
      await retainCodexAppServerLiveThread(harness.client, `thread-sibling-${index}`);
    }
    const unprotect = protectCodexAppServerLiveThread(harness.client, "thread-parent");
    await retainCodexAppServerLiveThread(harness.client, "thread-parent");

    unprotect();

    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    await vi.waitFor(async () => {
      await expect(releaseCodexAppServerLiveThread(harness.client, "thread-oldest")).resolves.toBe(
        true,
      );
    });
    expect(release).toHaveBeenCalledTimes(2);
    await expect(consumeCodexAppServerLiveThread(harness.client, "thread-parent")).resolves.toEqual(
      expect.objectContaining({ release: expect.any(Function) }),
    );
    await expect(
      consumeCodexAppServerLiveThread(harness.client, "thread-sibling-1"),
    ).resolves.toEqual(expect.objectContaining({ release: expect.any(Function) }));
  });

  it.each(["thread/archived", "thread/deleted", "thread/closed"])(
    "discards only the exact thread after %s",
    async (method) => {
      const harness = createClientHarness();
      clients.push(harness.client);
      ensureCodexAppServerClientRuntime(harness.client, { agentDir: "/tmp/agent" });
      await retainCodexAppServerLiveThread(harness.client, "thread-a");
      await retainCodexAppServerLiveThread(harness.client, "thread-b");
      const notificationObserved = new Promise<void>((resolve) => {
        harness.client.addNotificationHandler((notification) => {
          if (notification.method === method) {
            resolve();
          }
        });
      });

      harness.send({ method, params: { threadId: "thread-a" } });
      await notificationObserved;
      await expect(
        consumeCodexAppServerLiveThread(harness.client, "thread-a"),
      ).resolves.toBeUndefined();
      await expect(consumeCodexAppServerLiveThread(harness.client, "thread-b")).resolves.toEqual(
        expect.objectContaining({ release: expect.any(Function) }),
      );
    },
  );

  it("clears idle ownership and its timer when the physical client closes", async () => {
    vi.useFakeTimers();
    const harness = createClientHarness();
    clients.push(harness.client);
    ensureCodexAppServerClientRuntime(harness.client, { agentDir: "/tmp/agent" });
    const release = vi.fn(async (_threadId: string) => undefined);
    await retainCodexAppServerLiveThread(harness.client, "thread-closed", release);

    harness.client.close();
    await vi.advanceTimersByTimeAsync(EXPECTED_LIVE_THREAD_IDLE_TIMEOUT_MS);

    expect(release).not.toHaveBeenCalled();
    await expect(
      consumeCodexAppServerLiveThread(harness.client, "thread-closed"),
    ).resolves.toBeUndefined();
  });

  it("never publishes new live ownership after its physical client closes", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    ensureCodexAppServerClientRuntime(harness.client, { agentDir: "/tmp/agent" });

    harness.client.close();

    await expect(retainCodexAppServerLiveThread(harness.client, "thread-stale")).resolves.toBe(
      false,
    );
    await expect(
      consumeCodexAppServerLiveThread(harness.client, "thread-stale"),
    ).resolves.toBeUndefined();
  });

  it("cannot resurrect thread ownership when its client closes during release", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    ensureCodexAppServerClientRuntime(harness.client, { agentDir: "/tmp/agent" });
    let finishRelease: (() => void) | undefined;
    const pendingRelease = new Promise<void>((resolve) => {
      finishRelease = resolve;
    });
    await retainCodexAppServerLiveThread(
      harness.client,
      "thread-stale",
      async () => pendingRelease,
    );
    const release = releaseCodexAppServerLiveThread(harness.client, "thread-stale");
    const retain = retainCodexAppServerLiveThread(harness.client, "thread-stale");

    harness.client.close();
    finishRelease?.();

    await expect(release).resolves.toBe(true);
    await expect(retain).resolves.toBe(false);
    await expect(
      consumeCodexAppServerLiveThread(harness.client, "thread-stale"),
    ).resolves.toBeUndefined();
  });
});
