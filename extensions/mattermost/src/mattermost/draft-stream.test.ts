// Mattermost tests cover draft stream plugin behavior.
import { describe, expect, it, vi } from "vitest";
import type { MattermostClient } from "./client.js";
import {
  createMattermostDraftPreviewBoundaryController,
  createMattermostDraftStream,
} from "./draft-stream.js";

type RequestRecord = {
  path: string;
  init?: RequestInit;
};

function createMockClient(): {
  client: MattermostClient;
  calls: RequestRecord[];
  requestMock: ReturnType<typeof vi.fn>;
} {
  const calls: RequestRecord[] = [];
  let nextId = 1;
  const requestImpl: MattermostClient["request"] = async <T>(
    path: string,
    init?: RequestInit,
  ): Promise<T> => {
    calls.push({ path, init });
    if (path === "/posts") {
      return { id: `post-${nextId++}` } as T;
    }
    if (path.startsWith("/posts/")) {
      return { id: "patched" } as T;
    }
    return {} as T;
  };
  const requestMock = vi.fn(requestImpl);
  const client: MattermostClient = {
    baseUrl: "https://chat.example.com",
    apiBaseUrl: "https://chat.example.com/api/v4",
    token: "token",
    request: requestMock as MattermostClient["request"],
    fetchImpl: vi.fn() as MattermostClient["fetchImpl"],
  };
  return { client, calls, requestMock };
}

function parseRequestJson(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") {
    throw new Error("expected JSON request body");
  }
  const parsed: unknown = JSON.parse(init.body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("expected JSON object request body");
  }
  return parsed as Record<string, unknown>;
}

describe("createMattermostDraftStream", () => {
  it("creates a preview post and updates it on later changes", async () => {
    const { client, calls } = createMockClient();
    const stream = createMattermostDraftStream({
      client,
      channelId: "channel-1",
      rootId: "root-1",
      throttleMs: 0,
    });

    stream.update("Running `read`…");
    await stream.flush();
    stream.update("Running `read`…");
    await stream.flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/posts");

    expect(parseRequestJson(calls[0]?.init)).toEqual({
      channel_id: "channel-1",
      root_id: "root-1",
      message: "Running `read`…",
    });
    expect(stream.postId()).toBe("post-1");
  });

  it("does not resend identical updates", async () => {
    const { client, calls } = createMockClient();
    const stream = createMattermostDraftStream({
      client,
      channelId: "channel-1",
      throttleMs: 0,
    });

    stream.update("Working...");
    await stream.flush();
    stream.update("Working...");
    await stream.flush();

    expect(calls).toHaveLength(1);
  });

  it("clears the preview post when no final reply is delivered", async () => {
    const { client, calls } = createMockClient();
    const stream = createMattermostDraftStream({
      client,
      channelId: "channel-1",
      rootId: "root-1",
      throttleMs: 0,
    });

    stream.update("Working...");
    await stream.flush();
    await stream.clear();

    expect(calls).toHaveLength(2);
    expect(calls[1]?.path).toBe("/posts/post-1");
    expect(calls[1]?.init?.method).toBe("DELETE");
    expect(stream.postId()).toBeUndefined();
  });

  it("discardPending keeps the preview post but ignores later updates", async () => {
    const { client, calls } = createMockClient();
    const stream = createMattermostDraftStream({
      client,
      channelId: "channel-1",
      rootId: "root-1",
      throttleMs: 0,
    });

    stream.update("Working...");
    await stream.flush();
    await stream.discardPending();
    stream.update("Late update");
    await stream.flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/posts");
    expect(stream.postId()).toBe("post-1");
  });

  it("seal keeps the preview post and cancels pending final overwrites", async () => {
    const { client, calls } = createMockClient();
    const stream = createMattermostDraftStream({
      client,
      channelId: "channel-1",
      rootId: "root-1",
      throttleMs: 0,
    });

    stream.update("Working...");
    await stream.flush();
    stream.update("Stale final draft");
    await stream.seal();
    await stream.forceNewMessage();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/posts");
    expect(stream.postId()).toBe("post-1");
  });

  it("stop flushes the last pending update and ignores later ones", async () => {
    const { client, calls } = createMockClient();
    const stream = createMattermostDraftStream({
      client,
      channelId: "channel-1",
      rootId: "root-1",
      throttleMs: 1000,
    });

    stream.update("Working...");
    await stream.flush();
    stream.update("Stale partial");
    await stream.stop();
    stream.update("Late partial");
    await stream.flush();

    expect(calls).toHaveLength(2);
    expect(calls[0]?.path).toBe("/posts");
    expect(calls[1]?.path).toBe("/posts/post-1");
    expect(parseRequestJson(calls[1]?.init)).toEqual({
      id: "post-1",
      message: "Stale partial",
    });
  });

  it("warns and stops when preview creation fails", async () => {
    const warn = vi.fn();
    const requestImpl: MattermostClient["request"] = async () => {
      throw new Error("boom");
    };
    const requestMock = vi.fn(requestImpl);
    const client: MattermostClient = {
      baseUrl: "https://chat.example.com",
      apiBaseUrl: "https://chat.example.com/api/v4",
      token: "token",
      request: requestMock as MattermostClient["request"],
      fetchImpl: vi.fn() as MattermostClient["fetchImpl"],
    };
    const stream = createMattermostDraftStream({
      client,
      channelId: "channel-1",
      throttleMs: 0,
      warn,
    });

    stream.update("Working...");
    await stream.flush();
    stream.update("Still working...");
    await stream.flush();

    expect(warn).toHaveBeenCalled();
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(stream.postId()).toBeUndefined();
  });

  it("truncates on a code-point boundary so a straddling emoji is dropped whole", async () => {
    const { client, calls } = createMockClient();
    // maxChars=12 => cut point is maxChars-3=9. The emoji 😀 occupies UTF-16
    // indices 8-9, so a raw slice(0,9) would keep the lone high surrogate at
    // index 8 and drop its low surrogate at index 9, leaking a dangling half.
    const stream = createMattermostDraftStream({
      client,
      channelId: "channel-1",
      throttleMs: 0,
      maxChars: 12,
    });

    const input = `${"a".repeat(8)}\u{1F600}${"b".repeat(5)}`;
    stream.update(input);
    await stream.flush();

    expect(calls).toHaveLength(1);
    const message = parseRequestJson(calls[0]?.init).message;
    expect(typeof message).toBe("string");
    const sent = message as string;
    // The straddling emoji must be dropped whole, leaving no dangling surrogate half.
    expect(/[\uD800-\uDFFF]/u.test(sent)).toBe(false);
    expect(sent.length).toBeLessThanOrEqual(12);
    expect(sent).toBe("aaaaaaaa...");
  });

  it("does not resend after an update failure followed by stop", async () => {
    const warn = vi.fn();
    const calls: RequestRecord[] = [];
    let failNextPatch = true;
    const requestImpl: MattermostClient["request"] = async <T>(
      path: string,
      init?: RequestInit,
    ): Promise<T> => {
      calls.push({ path, init });
      if (path === "/posts") {
        return { id: "post-1" } as T;
      }
      if (path === "/posts/post-1") {
        if (failNextPatch) {
          failNextPatch = false;
          throw new Error("patch failed");
        }
        return { id: "patched" } as T;
      }
      return {} as T;
    };
    const requestMock = vi.fn(requestImpl);
    const client: MattermostClient = {
      baseUrl: "https://chat.example.com",
      apiBaseUrl: "https://chat.example.com/api/v4",
      token: "token",
      request: requestMock as MattermostClient["request"],
      fetchImpl: vi.fn() as MattermostClient["fetchImpl"],
    };
    const stream = createMattermostDraftStream({
      client,
      channelId: "channel-1",
      throttleMs: 1000,
      warn,
    });

    stream.update("Working...");
    await stream.flush();
    stream.update("Will fail");
    await stream.flush();
    await stream.stop();

    expect(warn).toHaveBeenCalledWith("mattermost stream preview failed: patch failed");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.path).toBe("/posts");
    expect(calls[1]?.path).toBe("/posts/post-1");
  });
});

describe("createMattermostDraftStream forceNewMessage", () => {
  it("creates a new post on the next update after forceNewMessage", async () => {
    const { client, calls } = createMockClient();
    const stream = createMattermostDraftStream({
      client,
      channelId: "channel-1",
      rootId: "root-1",
      throttleMs: 0,
    });

    stream.update("Running `read`…");
    await stream.flush();
    expect(stream.postId()).toBe("post-1");

    await stream.forceNewMessage();

    stream.update("Here are the contents.");
    await stream.flush();

    expect(calls).toHaveLength(2);
    expect(calls[0]?.path).toBe("/posts");
    expect(calls[1]?.path).toBe("/posts");
    expect(parseRequestJson(calls[0]?.init)).toEqual({
      channel_id: "channel-1",
      root_id: "root-1",
      message: "Running `read`…",
    });
    expect(parseRequestJson(calls[1]?.init)).toEqual({
      channel_id: "channel-1",
      root_id: "root-1",
      message: "Here are the contents.",
    });
    expect(stream.postId()).toBe("post-2");
  });

  it("restores and chunks an already-flushed over-limit block before rotating", async () => {
    const { client, calls } = createMockClient();
    const firstChunk = "a".repeat(10);
    const secondChunk = "b".repeat(10);
    const chunkText = vi.fn(() => [firstChunk, secondChunk]);
    const configuredStream = createMattermostDraftStream({
      client,
      channelId: "channel-1",
      throttleMs: 0,
      maxChars: 10,
      chunkText,
    });

    configuredStream.update(`${firstChunk}${secondChunk}`);
    await configuredStream.flush();
    expect(parseRequestJson(calls[0]?.init)?.message).toBe("aaaaaaa...");

    await configuredStream.forceNewMessage();
    expect(configuredStream.postId()).toBeUndefined();
    configuredStream.update("tool");
    await configuredStream.flush();

    expect(calls.map((call) => call.path)).toEqual(["/posts", "/posts/post-1", "/posts", "/posts"]);
    expect(calls.map((call) => call.init?.method)).toEqual(["POST", "PUT", "POST", "POST"]);
    const finalizedChunks = [
      parseRequestJson(calls[1]?.init)?.message,
      parseRequestJson(calls[2]?.init)?.message,
    ];
    expect(chunkText).toHaveBeenCalledWith(`${firstChunk}${secondChunk}`);
    expect(finalizedChunks).toEqual([firstChunk, secondChunk]);
    expect(finalizedChunks.join("")).toBe(`${firstChunk}${secondChunk}`);
    expect(parseRequestJson(calls[3]?.init)?.message).toBe("tool");
    expect(configuredStream.postId()).toBe("post-3");
  });

  it("publishes overlapping fire-and-forget boundaries in generation order", async () => {
    const calls: RequestRecord[] = [];
    let nextId = 1;
    let releaseFirstCreate: (() => void) | undefined;
    let releaseBoundaryPatch: (() => void) | undefined;
    let releaseSecondCreate: (() => void) | undefined;
    const firstCreateInFlight = new Promise<void>((resolve) => {
      releaseFirstCreate = resolve;
    });
    const boundaryPatchInFlight = new Promise<void>((resolve) => {
      releaseBoundaryPatch = resolve;
    });
    const secondCreateInFlight = new Promise<void>((resolve) => {
      releaseSecondCreate = resolve;
    });
    let createdCount = 0;
    const requestImpl: MattermostClient["request"] = async <T>(
      path: string,
      init?: RequestInit,
    ): Promise<T> => {
      calls.push({ path, init });
      if (path === "/posts") {
        createdCount += 1;
        if (createdCount === 1) {
          await firstCreateInFlight;
        }
        if (createdCount === 2) {
          await secondCreateInFlight;
        }
        return { id: `post-${nextId++}` } as T;
      }
      if (path.startsWith("/posts/")) {
        await boundaryPatchInFlight;
        return { id: "patched" } as T;
      }
      return {} as T;
    };
    const requestMock = vi.fn(requestImpl);
    const client: MattermostClient = {
      baseUrl: "https://chat.example.com",
      apiBaseUrl: "https://chat.example.com/api/v4",
      token: "token",
      request: requestMock as MattermostClient["request"],
      fetchImpl: vi.fn() as MattermostClient["fetchImpl"],
    };
    const stream = createMattermostDraftStream({
      client,
      channelId: "channel-1",
      throttleMs: 0,
    });

    stream.update("tool start");
    stream.update("tool complete");
    const firstBoundary = stream.forceNewMessage();
    stream.update("assistant progress");
    const secondBoundary = stream.forceNewMessage();
    stream.update("final answer");
    const flush = stream.flush();
    releaseFirstCreate?.();

    await vi.waitFor(() => {
      expect(calls.map((c) => c.path)).toEqual(["/posts", "/posts/post-1"]);
    });
    releaseBoundaryPatch?.();
    await vi.waitFor(() => {
      expect(calls.map((c) => c.path)).toEqual(["/posts", "/posts/post-1", "/posts"]);
    });
    releaseSecondCreate?.();
    await Promise.all([firstBoundary, secondBoundary, flush]);

    expect(calls.map((c) => c.path)).toEqual(["/posts", "/posts/post-1", "/posts", "/posts"]);
    expect(parseRequestJson(calls[0]?.init)?.message).toBe("tool start");
    expect(parseRequestJson(calls[1]?.init)?.message).toBe("tool complete");
    expect(parseRequestJson(calls[2]?.init)?.message).toBe("assistant progress");
    expect(parseRequestJson(calls[3]?.init)?.message).toBe("final answer");
    expect(stream.postId()).toBe("post-3");
  });

  it("seals a pending partial onto the in-flight created post instead of duplicating it", async () => {
    const calls: RequestRecord[] = [];
    let nextId = 1;
    let releaseFirstCreate: (() => void) | undefined;
    const firstCreateInFlight = new Promise<void>((resolve) => {
      releaseFirstCreate = resolve;
    });
    let createdCount = 0;
    const requestImpl: MattermostClient["request"] = async <T>(
      path: string,
      init?: RequestInit,
    ): Promise<T> => {
      calls.push({ path, init });
      if (path === "/posts") {
        createdCount += 1;
        if (createdCount === 1) {
          await firstCreateInFlight;
        }
        return { id: `post-${nextId++}` } as T;
      }
      if (path.startsWith("/posts/")) {
        return { id: "patched" } as T;
      }
      return {} as T;
    };
    const requestMock = vi.fn(requestImpl);
    const client: MattermostClient = {
      baseUrl: "https://chat.example.com",
      apiBaseUrl: "https://chat.example.com/api/v4",
      token: "token",
      request: requestMock as MattermostClient["request"],
      fetchImpl: vi.fn() as MattermostClient["fetchImpl"],
    };
    const stream = createMattermostDraftStream({
      client,
      channelId: "channel-1",
      throttleMs: 0,
    });

    stream.update("Looking into the logs");
    stream.update("Looking into the logs now");
    const boundary = stream.forceNewMessage();
    releaseFirstCreate?.();
    await boundary;

    expect(calls.map((c) => c.path)).toEqual(["/posts", "/posts/post-1"]);
    expect(parseRequestJson(calls[0]?.init)?.message).toBe("Looking into the logs");
    expect(parseRequestJson(calls[1]?.init)?.message).toBe("Looking into the logs now");
    expect(stream.postId()).toBeUndefined();
  });

  it("opens a fresh post for a partial that arrives before a fire-and-forget boundary settles", async () => {
    const { client, calls } = createMockClient();
    const stream = createMattermostDraftStream({
      client,
      channelId: "channel-1",
      throttleMs: 0,
    });

    stream.update("block A");
    await stream.flush();
    expect(stream.postId()).toBe("post-1");

    const boundary = stream.forceNewMessage();
    expect(stream.postId()).toBeUndefined();
    stream.update("block B");
    await boundary;
    await stream.flush();

    expect(calls.map((c) => c.path)).toEqual(["/posts", "/posts"]);
    expect(parseRequestJson(calls[0]?.init)?.message).toBe("block A");
    expect(parseRequestJson(calls[1]?.init)?.message).toBe("block B");
    expect(stream.postId()).toBe("post-2");
  });

  it("resolves a cumulative terminal reply to the current confirmed generation", async () => {
    const { client } = createMockClient();
    const stream = createMattermostDraftStream({
      client,
      channelId: "channel-1",
      throttleMs: 0,
    });

    stream.updateAssistantText("First block");
    await stream.flush();
    await stream.forceNewMessage();
    stream.updateAssistantText("Second block");
    await stream.flush();

    expect(stream.resolveFinalText("First block\n\nSecond block complete")).toEqual({
      kind: "remaining",
      text: "Second block complete",
    });
    expect(stream.resolveFinalText("Second block complete")).toEqual({
      kind: "full",
      text: "Second block complete",
    });
    expect(stream.resolveFinalText("First block extended")).toEqual({
      kind: "full",
      text: "First block extended",
    });
  });

  it("strips confirmed assistant blocks but not transient progress generations", async () => {
    const { client } = createMockClient();
    const stream = createMattermostDraftStream({
      client,
      channelId: "channel-1",
      throttleMs: 0,
    });

    stream.updateAssistantText("First block");
    await stream.flush();
    await stream.forceNewMessage();
    stream.update("Running tool…");
    await stream.flush();
    await stream.forceNewMessage();
    await stream.settleBoundaries();

    expect(stream.resolveFinalText("First block\n\nFinal after tool")).toEqual({
      kind: "remaining",
      text: "Final after tool",
    });
    expect(stream.resolveFinalText("First block extended")).toEqual({
      kind: "full",
      text: "First block extended",
    });
    expect(stream.resolveFinalText("First block")).toEqual({ kind: "already-delivered" });
  });

  it("keeps the canonical final when an assistant boundary fails to publish", async () => {
    const { client, requestMock } = createMockClient();
    const stream = createMattermostDraftStream({
      client,
      channelId: "channel-1",
      throttleMs: 0,
    });

    stream.updateAssistantText("First block");
    await stream.flush();
    requestMock.mockRejectedValueOnce(new Error("boundary failed"));
    stream.updateAssistantText("First block complete");
    await stream.forceNewMessage();

    const finalText = "First block complete\n\nFinal after failure";
    expect(stream.resolveFinalText(finalText)).toEqual({ kind: "full", text: finalText });
  });
});

describe("createMattermostDraftPreviewBoundaryController", () => {
  it("calls forceNewMessage on boundary when enabled and content was streamed", async () => {
    const forceNewMessage = vi.fn();
    const controller = createMattermostDraftPreviewBoundaryController({
      enabled: true,
      forceNewMessage,
    });

    controller.noteUpdate();
    await controller.noteBoundary();

    expect(forceNewMessage).toHaveBeenCalledTimes(1);
  });

  it("skips forceNewMessage when no content was streamed since the last boundary", async () => {
    const forceNewMessage = vi.fn();
    const controller = createMattermostDraftPreviewBoundaryController({
      enabled: true,
      forceNewMessage,
    });

    await controller.noteBoundary();
    await controller.noteBoundary();
    controller.noteUpdate();
    await controller.noteBoundary();
    await controller.noteBoundary();

    expect(forceNewMessage).toHaveBeenCalledTimes(1);
  });

  it("never calls forceNewMessage when disabled", async () => {
    const forceNewMessage = vi.fn();
    const controller = createMattermostDraftPreviewBoundaryController({
      enabled: false,
      forceNewMessage,
    });

    controller.noteUpdate();
    await controller.noteBoundary();
    controller.noteUpdate();
    await controller.noteBoundary();

    expect(forceNewMessage).not.toHaveBeenCalled();
  });

  it("awaits the forceNewMessage promise before resolving the boundary", async () => {
    let releaseForce: (() => void) | undefined;
    const forcePending = new Promise<void>((resolve) => {
      releaseForce = resolve;
    });
    const forceNewMessage = vi.fn(async () => {
      await forcePending;
    });
    const controller = createMattermostDraftPreviewBoundaryController({
      enabled: true,
      forceNewMessage,
    });

    controller.noteUpdate();
    let resolved = false;
    const boundary = controller.noteBoundary().then(() => {
      resolved = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    releaseForce?.();
    await boundary;
    expect(resolved).toBe(true);
    expect(forceNewMessage).toHaveBeenCalledTimes(1);
  });

  it("splits the next boundary when a noteUpdate arrives while the prior boundary is pending", async () => {
    const releases: Array<() => void> = [];
    const forceNewMessage = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        }),
    );
    const controller = createMattermostDraftPreviewBoundaryController({
      enabled: true,
      forceNewMessage,
    });

    controller.noteUpdate();
    const firstBoundary = controller.noteBoundary();
    controller.noteUpdate();
    releases[0]?.();
    await firstBoundary;

    const secondBoundary = controller.noteBoundary();
    releases[1]?.();
    await secondBoundary;

    expect(forceNewMessage).toHaveBeenCalledTimes(2);
  });
});
