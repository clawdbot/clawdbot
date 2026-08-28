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
  rememberChatMetadata,
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
  it("returns a cached result without requesting it again", async () => {
    const result = metadata("cached-model");
    const request = vi.fn().mockResolvedValue(result);
    const client = clientWith(request);

    await expect(loadChatMetadata(client, " main ")).resolves.toBe(result);
    await expect(loadChatMetadata(client, "main")).resolves.toBe(result);

    expect(request).toHaveBeenCalledOnce();
  });

  it("shares one pending load between concurrent readers", async () => {
    const pending = deferred<ChatMetadataResult>();
    const request = vi.fn().mockReturnValue(pending.promise);
    const client = clientWith(request);

    const first = loadChatMetadata(client, "main");
    const second = loadChatMetadata(client, "main");

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

    await expect(loadChatMetadata(client, "main")).rejects.toThrow("metadata unavailable");
    await expect(loadChatMetadata(client, "main")).resolves.toBe(result);

    expect(request).toHaveBeenCalledTimes(2);
  });

  it("uses remembered startup metadata as the current snapshot", async () => {
    const result = metadata("startup-model");
    const request = vi.fn();
    const client = clientWith(request);

    rememberChatMetadata(client, "main", result);

    expect(peekChatMetadata(client, "main")).toBe(result);
    await expect(loadChatMetadata(client, "main")).resolves.toBe(result);
    expect(request).not.toHaveBeenCalled();
  });

  it("notifies subscribers across publication and invalidation", () => {
    const client = clientWith(vi.fn());
    const listener = vi.fn();
    const unsubscribe = subscribeChatMetadata(client, "main", listener);

    rememberChatMetadata(client, "main", metadata("first-model"));
    invalidateChatMetadataStore(client);
    rememberChatMetadata(client, "main", metadata("second-model"));

    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
    rememberChatMetadata(client, "main", metadata("ignored-model"));
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("keeps a ready snapshot after its last subscriber releases", async () => {
    const result = metadata("cached-after-release");
    const request = vi.fn();
    const client = clientWith(request);
    const unsubscribe = subscribeChatMetadata(client, "main", () => undefined);
    rememberChatMetadata(client, "main", result);

    unsubscribe();

    expect(peekChatMetadata(client, "main")).toBe(result);
    await expect(loadChatMetadata(client, "main")).resolves.toBe(result);
    expect(request).not.toHaveBeenCalled();
  });

  it("drops every agent snapshot when the client store is invalidated", async () => {
    const main = metadata("main-model");
    const worker = metadata("worker-model");
    const request = vi.fn().mockResolvedValue(main);
    const client = clientWith(request);
    rememberChatMetadata(client, "main", main);
    rememberChatMetadata(client, "worker", worker);

    invalidateChatMetadataStore(client);

    expect(peekChatMetadata(client, "main")).toBeUndefined();
    expect(peekChatMetadata(client, "worker")).toBeUndefined();
    await expect(loadChatMetadata(client, "main")).resolves.toBe(main);
    expect(request).toHaveBeenCalledOnce();
  });

  it("keeps the stale snapshot readable while one fresh revalidation replaces it", async () => {
    const oldResult = metadata("old-model");
    const nextResult = metadata("next-model");
    const refresh = deferred<ChatMetadataResult>();
    const request = vi.fn().mockReturnValue(refresh.promise);
    const client = clientWith(request);
    rememberChatMetadata(client, "main", oldResult);

    const first = revalidateChatMetadata(client, "main");
    const second = revalidateChatMetadata(client, "main");

    expect(second).toBe(first);
    expect(peekChatMetadata(client, "main")).toBe(oldResult);
    expect(request).toHaveBeenCalledOnce();
    refresh.resolve(nextResult);
    await expect(first).resolves.toBe(nextResult);
    expect(peekChatMetadata(client, "main")).toBe(nextResult);
  });

  it("does not let an older plain load clobber a newer revalidation", async () => {
    const older = deferred<ChatMetadataResult>();
    const newer = deferred<ChatMetadataResult>();
    const request = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const client = clientWith(request);

    const olderLoad = loadChatMetadata(client, "main");
    const newerLoad = revalidateChatMetadata(client, "main");
    newer.resolve(metadata("new-model"));
    await newerLoad;
    older.resolve(metadata("old-model"));
    await olderLoad;

    expect(peekChatMetadata(client, "main")).toEqual(metadata("new-model"));
  });

  it("retries canonical startup unavailability and caches the recovered catalog", async () => {
    vi.useFakeTimers();
    const result = metadata("recovered-model");
    const request = vi
      .fn()
      .mockRejectedValueOnce(startupUnavailableError(250))
      .mockResolvedValueOnce(result);
    const client = clientWith(request);

    const refresh = revalidateChatMetadata(client, "main", {
      startupRetryWindowMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(249);
    expect(request).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);

    await expect(refresh).resolves.toBe(result);
    expect(request).toHaveBeenCalledTimes(2);
    expect(peekChatMetadata(client, "main")).toBe(result);
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

    const refresh = revalidateChatMetadata(client, "main", {
      startupRetryWindowMs: 60_000,
    });
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
    const refresh = revalidateChatMetadata(client, "main", {
      startupRetryWindowMs: 60_000,
    });
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
