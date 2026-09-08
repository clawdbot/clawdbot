import {
  DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
  gatewayStartupUnavailableDetails,
} from "@openclaw/gateway-client/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import {
  invalidateChatMetadataStore,
  loadChatMetadata,
  peekChatMetadata,
  beginChatMetadataPublication,
  revalidateChatMetadata,
  subscribeChatMetadata,
  type ChatMetadataResult,
} from "./chat-metadata-store.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function clientWith(request: ReturnType<typeof vi.fn>): GatewayBrowserClient {
  return { request } as unknown as GatewayBrowserClient;
}

function metadata(modelId: string): ChatMetadataResult {
  return {
    commands: [],
    models: [{ id: modelId, name: modelId, provider: "openai" }],
  };
}

function startupUnavailableError(retryAfterMs = 250): GatewayRequestError {
  return new GatewayRequestError({
    code: "UNAVAILABLE",
    message: "gateway startup sidecars are still initializing",
    details: gatewayStartupUnavailableDetails(),
    retryable: true,
    retryAfterMs,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("chat metadata store", () => {
  it.each([
    { sessionKey: "agent:main:locked" },
    { authProfileId: "personal:person-a:anthropic:one" },
  ])("isolates selected metadata %j and releases its last subscriber", async (selection) => {
    const client = clientWith(vi.fn().mockResolvedValue(metadata("neutral")));
    const scope = { agentId: "main", ...selection };
    const first = subscribeChatMetadata(client, scope, () => {});
    const second = subscribeChatMetadata(client, scope, () => {});
    beginChatMetadataPublication(client, scope).publish(metadata("locked"));
    await loadChatMetadata(client, { agentId: "main" });
    expect(peekChatMetadata(client, { agentId: "main" })).toEqual(metadata("neutral"));
    expect(peekChatMetadata(client, scope)).toEqual(metadata("locked"));
    first();
    expect(peekChatMetadata(client, scope)).toEqual(metadata("locked"));
    const lateStartup = beginChatMetadataPublication(client, scope);
    second();
    lateStartup.publish(metadata("late"));
    expect(peekChatMetadata(client, scope)).toBeUndefined();
    expect(peekChatMetadata(client, { agentId: "main" })).toEqual(metadata("neutral"));
  });

  it("retires all writers before invalidation callbacks and rejects stale startup, reads, and errors", async () => {
    const older = deferred<ChatMetadataResult>();
    const replacement = metadata("current");
    const request = vi.fn().mockReturnValueOnce(older.promise).mockResolvedValue(replacement);
    const client = clientWith(request);
    const scope = { agentId: "main", sessionKey: "agent:main:locked" };
    const updates: string[] = [];
    const unsubscribe = subscribeChatMetadata(client, scope, (update) => {
      updates.push(update.type);
      if (update.type === "invalidated") {
        void loadChatMetadata(client, scope);
      }
    });
    const startup = beginChatMetadataPublication(client, scope);
    const oldRead = loadChatMetadata(client, scope).catch(() => undefined);
    invalidateChatMetadataStore(client);
    await vi.waitFor(() => expect(peekChatMetadata(client, scope)).toBe(replacement));
    startup.publish(metadata("obsolete-startup"));
    older.reject(new Error("obsolete-read"));
    await oldRead;
    expect(peekChatMetadata(client, scope)).toBe(replacement);
    expect(updates).not.toContain("error");
    expect(request).toHaveBeenLastCalledWith("chat.metadata", scope);
    unsubscribe();
  });

  it("returns a cached result without requesting it again", async () => {
    const result = metadata("cached-model");
    const request = vi.fn().mockResolvedValue(result);
    const client = clientWith(request);

    await expect(loadChatMetadata(client, { agentId: "main" })).resolves.toBe(result);
    await expect(loadChatMetadata(client, { agentId: "main" })).resolves.toBe(result);

    expect(request).toHaveBeenCalledOnce();
  });

  it("shares one pending load between concurrent readers", async () => {
    const pending = deferred<ChatMetadataResult>();
    const request = vi.fn().mockReturnValue(pending.promise);
    const client = clientWith(request);

    const first = loadChatMetadata(client, { agentId: "main" });
    const second = loadChatMetadata(client, { agentId: "main" });

    expect(second).toBe(first);
    expect(request).toHaveBeenCalledOnce();
    pending.resolve(metadata("shared-model"));
    await expect(first).resolves.toEqual(metadata("shared-model"));
  });

  it("clears a failed pending load so a later read can retry", async () => {
    const result = metadata("recovered-model");
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("metadata unavailable"))
      .mockResolvedValueOnce(result);
    const client = clientWith(request);

    await expect(loadChatMetadata(client, { agentId: "main" })).rejects.toThrow(
      "metadata unavailable",
    );
    await expect(loadChatMetadata(client, { agentId: "main" })).resolves.toBe(result);

    expect(request).toHaveBeenCalledTimes(2);
  });

  it("uses remembered startup metadata as the current snapshot", async () => {
    const result = metadata("startup-model");
    const request = vi.fn();
    const client = clientWith(request);

    beginChatMetadataPublication(client, { agentId: "main" }).publish(result);

    expect(peekChatMetadata(client, { agentId: "main" })).toBe(result);
    await expect(loadChatMetadata(client, { agentId: "main" })).resolves.toBe(result);
    expect(request).not.toHaveBeenCalled();
  });

  it("notifies subscribers across publication and invalidation", () => {
    const client = clientWith(vi.fn());
    const listener = vi.fn();
    const unsubscribe = subscribeChatMetadata(client, { agentId: "main" }, listener);

    beginChatMetadataPublication(client, { agentId: "main" }).publish(metadata("first-model"));
    invalidateChatMetadataStore(client);
    beginChatMetadataPublication(client, { agentId: "main" }).publish(metadata("second-model"));

    expect(listener.mock.calls.filter(([update]) => update.type !== "loading")).toHaveLength(3);
    unsubscribe();
    beginChatMetadataPublication(client, { agentId: "main" }).publish(metadata("ignored-model"));
    expect(listener.mock.calls.filter(([update]) => update.type !== "loading")).toHaveLength(3);
  });

  it("keeps a ready snapshot after its last subscriber releases", async () => {
    const result = metadata("cached-after-release");
    const request = vi.fn();
    const client = clientWith(request);
    const unsubscribe = subscribeChatMetadata(client, { agentId: "main" }, () => undefined);
    beginChatMetadataPublication(client, { agentId: "main" }).publish(result);

    unsubscribe();

    expect(peekChatMetadata(client, { agentId: "main" })).toBe(result);
    await expect(loadChatMetadata(client, { agentId: "main" })).resolves.toBe(result);
    expect(request).not.toHaveBeenCalled();
  });

  it("drops every agent snapshot when the client store is invalidated", async () => {
    const main = metadata("main-model");
    const worker = metadata("worker-model");
    const request = vi.fn().mockResolvedValue(main);
    const client = clientWith(request);
    beginChatMetadataPublication(client, { agentId: "main" }).publish(main);
    beginChatMetadataPublication(client, { agentId: "worker" }).publish(worker);

    invalidateChatMetadataStore(client);

    expect(peekChatMetadata(client, { agentId: "main" })).toBeUndefined();
    expect(peekChatMetadata(client, { agentId: "worker" })).toBeUndefined();
    await expect(loadChatMetadata(client, { agentId: "main" })).resolves.toBe(main);
    expect(request).toHaveBeenCalledOnce();
  });

  it("keeps the stale snapshot readable while one fresh revalidation replaces it", async () => {
    const oldResult = metadata("old-model");
    const nextResult = metadata("next-model");
    const refresh = deferred<ChatMetadataResult>();
    const request = vi.fn().mockReturnValue(refresh.promise);
    const client = clientWith(request);
    beginChatMetadataPublication(client, { agentId: "main" }).publish(oldResult);

    const first = revalidateChatMetadata(client, { agentId: "main" });
    const second = revalidateChatMetadata(client, { agentId: "main" });

    expect(second).toBe(first);
    expect(peekChatMetadata(client, { agentId: "main" })).toBe(oldResult);
    expect(request).toHaveBeenCalledOnce();
    refresh.resolve(nextResult);
    await expect(first).resolves.toBe(nextResult);
    expect(peekChatMetadata(client, { agentId: "main" })).toBe(nextResult);
  });

  it("does not let an older plain load clobber a newer revalidation", async () => {
    const older = deferred<ChatMetadataResult>();
    const newer = deferred<ChatMetadataResult>();
    const request = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const client = clientWith(request);

    const olderLoad = loadChatMetadata(client, { agentId: "main" });
    const newerLoad = revalidateChatMetadata(client, { agentId: "main" });
    newer.resolve(metadata("new-model"));
    await newerLoad;
    older.resolve(metadata("old-model"));
    await olderLoad;

    expect(peekChatMetadata(client, { agentId: "main" })).toEqual(metadata("new-model"));
  });

  it("retries canonical startup unavailability and caches the recovered catalog", async () => {
    vi.useFakeTimers();
    const result = metadata("recovered-model");
    const request = vi
      .fn()
      .mockRejectedValueOnce(startupUnavailableError(250))
      .mockResolvedValueOnce(result);
    const client = clientWith(request);

    const refresh = revalidateChatMetadata(
      client,
      { agentId: "main" },
      {
        startupRetryWindowMs: 60_000,
      },
    );
    await vi.advanceTimersByTimeAsync(249);
    expect(request).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);

    await expect(refresh).resolves.toBe(result);
    expect(request).toHaveBeenCalledTimes(2);
    expect(peekChatMetadata(client, { agentId: "main" })).toBe(result);
  });

  it("does not retry unrelated retryable unavailable errors", async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockRejectedValue(
      new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "database temporarily unavailable",
        details: { reason: "database-busy" },
        retryable: true,
        retryAfterMs: 250,
      }),
    );
    const client = clientWith(request);

    const refresh = revalidateChatMetadata(
      client,
      { agentId: "main" },
      {
        startupRetryWindowMs: 60_000,
      },
    );
    const rejection = expect(refresh).rejects.toThrow("database temporarily unavailable");
    await vi.advanceTimersByTimeAsync(2_000);

    await rejection;
    expect(request).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops startup retries at the configured deadline", async () => {
    vi.useFakeTimers();
    const startedAt = Date.UTC(2026, 7, 2);
    vi.setSystemTime(startedAt);
    const attemptTimes: number[] = [];
    const request = vi.fn().mockImplementation(() => {
      attemptTimes.push(Date.now());
      return Promise.reject(startupUnavailableError(2_000));
    });
    const client = clientWith(request);
    const refresh = revalidateChatMetadata(
      client,
      { agentId: "main" },
      {
        startupRetryWindowMs: 60_000,
      },
    );
    const rejection = expect(refresh).rejects.toThrow("gateway startup sidecars");

    await vi.advanceTimersByTimeAsync(60_000);
    await rejection;

    expect(attemptTimes).toHaveLength(30);
    expect(attemptTimes[0]).toBe(startedAt);
    expect(attemptTimes.at(-1)).toBe(startedAt + 58_000);
    expect(request).toHaveBeenNthCalledWith(
      1,
      "chat.metadata",
      { agentId: "main" },
      { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS },
    );
    expect(request).toHaveBeenLastCalledWith(
      "chat.metadata",
      { agentId: "main" },
      { timeoutMs: 2_000 },
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});
