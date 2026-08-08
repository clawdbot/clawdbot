import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import { createClientHarness } from "./test-support.js";

const EXPECTED_LIVE_THREAD_IDLE_TIMEOUT_MS = 30 * 60_000;
const EXPECTED_MAX_IDLE_LIVE_THREADS = 64;

const mocks = vi.hoisted(() => ({
  refreshAuth: vi.fn(async () => ({ accessToken: "refreshed", chatgptAccountId: "account" })),
  mergeRateLimitUpdate: vi.fn(),
}));

vi.mock("./auth-bridge.js", () => ({
  refreshCodexAppServerAuthTokens: mocks.refreshAuth,
}));

vi.mock("./rate-limit-cache.js", () => ({
  mergeCodexRateLimitsUpdate: mocks.mergeRateLimitUpdate,
}));

const {
  consumeCodexAppServerLiveThread,
  ensureCodexAppServerClientRuntime,
  protectCodexAppServerLiveThread,
  releaseCodexAppServerLiveThread,
  retainCodexAppServerLiveThread,
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
    expect(mocks.refreshAuth).toHaveBeenCalledWith(updatedContext);
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

  it("does not re-expose a failed release or discard an unrelated conversation", async () => {
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
    await expect(
      consumeCodexAppServerLiveThread(harness.client, "thread-a"),
    ).resolves.toBeUndefined();
    await expect(consumeCodexAppServerLiveThread(harness.client, "thread-b")).resolves.toEqual(
      expect.objectContaining({ release: expect.any(Function) }),
    );
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
    await expect(consumeCodexAppServerLiveThread(harness.client, "thread-1")).resolves.toEqual(
      expect.objectContaining({ release }),
    );
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
});
