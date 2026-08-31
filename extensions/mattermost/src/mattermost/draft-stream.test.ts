// Mattermost tests cover draft stream plugin behavior.
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
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

type DraftStreamOptions = Omit<
  Parameters<typeof createMattermostDraftStream>[0],
  "client" | "channelId"
> & {
  request?: MattermostClient["request"];
};

function createDraftStreamFixture(options: DraftStreamOptions = {}): {
  client: MattermostClient;
  calls: RequestRecord[];
  requestMock: ReturnType<typeof vi.fn<MattermostClient["request"]>>;
  stream: ReturnType<typeof createMattermostDraftStream>;
} {
  const { request, ...streamOptions } = options;
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
  const requestMock = vi.fn(request ?? requestImpl);
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
    ...streamOptions,
  });
  return { client, calls, requestMock, stream };
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
    const { calls, stream } = createDraftStreamFixture({ rootId: "root-1" });

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
    const { calls, stream } = createDraftStreamFixture();

    stream.update("Working...");
    await stream.flush();
    stream.update("Working...");
    await stream.flush();

    expect(calls).toHaveLength(1);
  });

  it("clears the preview post when no final reply is delivered", async () => {
    const { calls, stream } = createDraftStreamFixture({ rootId: "root-1" });

    stream.update("Working...");
    await stream.flush();
    await stream.clear();

    expect(calls).toHaveLength(2);
    expect(calls[1]?.path).toBe("/posts/post-1");
    expect(calls[1]?.init?.method).toBe("DELETE");
    expect(stream.postId()).toBeUndefined();
  });

  it("discardPending keeps the preview post but ignores later updates", async () => {
    const { calls, stream } = createDraftStreamFixture({ rootId: "root-1" });

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
    const { calls, stream } = createDraftStreamFixture({ rootId: "root-1" });

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
    const { calls, stream } = createDraftStreamFixture({ rootId: "root-1", throttleMs: 1000 });

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
    const { requestMock, stream } = createDraftStreamFixture({ request: requestImpl, warn });

    stream.update("Working...");
    await stream.flush();
    stream.update("Still working...");
    await stream.flush();

    expect(warn).toHaveBeenCalled();
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(stream.postId()).toBeUndefined();
  });

  it("retains an accepted preview failure after its background flush has settled", async () => {
    const warn = vi.fn();
    const { requestMock, stream } = createDraftStreamFixture({ warn });
    requestMock.mockResolvedValueOnce({ message: "already visible" });

    stream.update("Already delivered");
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());

    let caught: unknown;
    try {
      await stream.flush();
    } catch (error) {
      caught = error;
    }
    expect(isChannelPartialDeliveryError(caught)).toBe(true);
    expect(requestMock).toHaveBeenCalledOnce();
    expect(requestMock.mock.calls[0]?.[0]).toBe("/posts");
    stream.update("Must not create another accepted post");
    await expect(stream.flush()).rejects.toThrow("did not include a post id");
    expect(requestMock).toHaveBeenCalledOnce();
    for (const finish of [
      () => stream.discardPending(),
      () => stream.clear(),
      () => stream.seal(),
      () => stream.stop(),
      () => stream.forceNewMessage(),
      () => stream.settleBoundaries(),
    ]) {
      await expect(finish()).rejects.toThrow("did not include a post id");
    }
    expect(requestMock).toHaveBeenCalledOnce();
  });

  it("truncates on a code-point boundary so a straddling emoji is dropped whole", async () => {
    // maxChars=12 => cut point is maxChars-3=9. The emoji 😀 occupies UTF-16
    // indices 8-9, so a raw slice(0,9) would keep the lone high surrogate at
    // index 8 and drop its low surrogate at index 9, leaking a dangling half.
    const { calls, stream } = createDraftStreamFixture({ maxChars: 12 });

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
    const { stream } = createDraftStreamFixture({ request: requestImpl, throttleMs: 1000, warn });

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
  it("propagates a provider-accepted boundary post without an identity", async () => {
    const { requestMock, stream } = createDraftStreamFixture({
      maxChars: 10,
      chunkText: () => ["aaaaaaaaaa", "bbbbbbbbbb"],
    });

    stream.updateAssistantText("aaaaaaaaaabbbbbbbbbb");
    await stream.flush();
    requestMock
      .mockResolvedValueOnce({ id: "post-1", message: "aaaaaaaaaa" })
      .mockResolvedValueOnce({ message: "already visible" });

    await expect(stream.forceNewMessage()).rejects.toThrow("did not include a post id");
    await expect(stream.flush()).rejects.toThrow("did not include a post id");
    expect(requestMock.mock.calls.filter(([path]) => path === "/posts")).toHaveLength(2);
  });

  it("retains accepted boundary failures before synchronous warning callbacks re-enter", async () => {
    let reenteredBoundary: Promise<void> | undefined;
    const warn = vi.fn(() => {
      stream.update("must not publish twice");
      reenteredBoundary = stream.forceNewMessage();
      void reenteredBoundary.catch(() => {});
    });
    const { requestMock, stream } = createDraftStreamFixture({
      maxChars: 10,
      chunkText: () => ["aaaaaaaaaa", "bbbbbbbbbb"],
      warn,
    });

    stream.updateAssistantText("aaaaaaaaaabbbbbbbbbb");
    await stream.flush();
    requestMock
      .mockResolvedValueOnce({ id: "post-1", message: "aaaaaaaaaa" })
      .mockResolvedValueOnce({ message: "already visible" });

    await expect(stream.forceNewMessage()).rejects.toThrow("did not include a post id");
    await expect(reenteredBoundary).rejects.toThrow("did not include a post id");
    expect(warn).toHaveBeenCalledOnce();
    expect(requestMock.mock.calls.filter(([path]) => path === "/posts")).toHaveLength(2);
  });

  it("propagates an accepted background failure that settles during boundary rotation", async () => {
    const { requestMock, stream } = createDraftStreamFixture();
    let releaseCreate: (() => void) | undefined;
    const createReady = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    requestMock.mockImplementationOnce(async () => {
      await createReady;
      return { message: "already visible" };
    });

    stream.update("Accepted background preview");
    await vi.waitFor(() => expect(requestMock).toHaveBeenCalledOnce());
    const boundary = stream.forceNewMessage();
    releaseCreate?.();

    await expect(boundary).rejects.toThrow("did not include a post id");
    await expect(stream.flush()).rejects.toThrow("did not include a post id");
    expect(requestMock).toHaveBeenCalledOnce();
  });

  it("creates a new post on the next update after forceNewMessage", async () => {
    const { calls, stream } = createDraftStreamFixture({ rootId: "root-1" });

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
    const firstChunk = "a".repeat(10);
    const secondChunk = "b".repeat(10);
    const chunkText = vi.fn(() => [firstChunk, secondChunk]);
    const { calls, stream: configuredStream } = createDraftStreamFixture({
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
    const { stream } = createDraftStreamFixture({ request: requestImpl });

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
    const { stream } = createDraftStreamFixture({ request: requestImpl });

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
    const { calls, stream } = createDraftStreamFixture();

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
    const { stream } = createDraftStreamFixture();

    stream.updateAssistantText("First block");
    await stream.flush();
    await stream.forceNewMessage();
    stream.updateAssistantText("Second block");
    await stream.flush();

    expect(stream.resolveFinalText("First block\n\nSecond block complete")).toEqual({
      kind: "remaining",
      text: "Second block complete",
      publishedParts: [{ messageId: "post-1", content: "First block" }],
    });
    expect(stream.resolveFinalText("Second block complete")).toEqual({
      kind: "full",
      text: "Second block complete",
      publishedParts: [{ messageId: "post-1", content: "First block" }],
    });
    expect(stream.resolveFinalText("First block extended")).toEqual({
      kind: "full",
      text: "First block extended",
      publishedParts: [{ messageId: "post-1", content: "First block" }],
    });
  });

  it("strips confirmed assistant blocks but not transient progress generations", async () => {
    const { stream } = createDraftStreamFixture();

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
      publishedParts: [{ messageId: "post-1", content: "First block" }],
    });
    expect(stream.resolveFinalText("First block extended")).toEqual({
      kind: "full",
      text: "First block extended",
      publishedParts: [{ messageId: "post-1", content: "First block" }],
    });
    expect(stream.resolveFinalText("First block")).toEqual({
      kind: "already-delivered",
      publishedParts: [{ messageId: "post-1", content: "First block" }],
    });
    expect(stream.resolveFinalText("")).toEqual({
      kind: "full",
      text: "",
      publishedParts: [{ messageId: "post-1", content: "First block" }],
    });
  });

  it("uses provider-finalized content from a boundary edit", async () => {
    const { requestMock, stream } = createDraftStreamFixture();

    stream.updateAssistantText("Draft block");
    await stream.flush();
    requestMock.mockResolvedValueOnce({ id: "post-1", message: "Provider-finalized block" });
    stream.updateAssistantText("Completed block");
    await stream.forceNewMessage();

    expect(stream.resolveFinalText("Completed block")).toEqual({
      kind: "already-delivered",
      publishedParts: [{ messageId: "post-1", content: "Provider-finalized block" }],
    });
  });

  it("keeps the canonical final when an assistant boundary fails to publish", async () => {
    const { requestMock, stream } = createDraftStreamFixture();

    stream.updateAssistantText("First block");
    await stream.flush();
    requestMock.mockRejectedValueOnce(new Error("boundary failed"));
    stream.updateAssistantText("First block complete");
    await stream.forceNewMessage();

    const finalText = "First block complete\n\nFinal after failure";
    expect(stream.resolveFinalText(finalText)).toEqual({
      kind: "remaining",
      text: "complete\n\nFinal after failure",
      publishedParts: [{ messageId: "post-1", content: "First block" }],
    });
  });

  it("retains posts published before a later boundary chunk fails", async () => {
    const { requestMock, stream } = createDraftStreamFixture({
      chunkText: () => ["First half", "Second half"],
    });

    stream.updateAssistantText("First half Second half");
    await stream.flush();
    requestMock
      .mockResolvedValueOnce({ id: "post-1", message: "First half" })
      .mockRejectedValueOnce(new Error("second chunk failed"));
    await stream.forceNewMessage();

    const finalText = "First half Second half\n\nFinal after failure";
    expect(stream.resolveFinalText(finalText)).toEqual({
      kind: "remaining",
      text: "Second half\n\nFinal after failure",
      publishedParts: [{ messageId: "post-1", content: "First half" }],
    });
  });

  it("does not strip a requested prefix rewritten by the provider", async () => {
    const { requestMock, stream } = createDraftStreamFixture({
      chunkText: () => ["First half", "Second half"],
    });

    stream.updateAssistantText("First half Second half");
    await stream.flush();
    requestMock
      .mockResolvedValueOnce({ id: "post-1", message: "Provider rewrite" })
      .mockRejectedValueOnce(new Error("second chunk failed"));
    await stream.forceNewMessage();

    const finalText = "First half Second half\n\nFinal after failure";
    expect(stream.resolveFinalText(finalText)).toEqual({
      kind: "full",
      text: finalText,
      publishedParts: [{ messageId: "post-1", content: "Provider rewrite" }],
    });
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
