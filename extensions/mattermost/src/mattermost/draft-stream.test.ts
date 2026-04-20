import { describe, expect, it, vi } from "vitest";
import type { MattermostClient } from "./client.js";
import { buildMattermostToolStatusText, createMattermostDraftStream } from "./draft-stream.js";

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

    const createBody = JSON.parse((calls[0]?.init?.body as string | undefined) ?? "{}");
    expect(createBody).toMatchObject({
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
    expect(JSON.parse((calls[1]?.init?.body as string | undefined) ?? "{}")).toMatchObject({
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

describe("buildMattermostToolStatusText", () => {
  it("renders a status with the tool name", () => {
    expect(buildMattermostToolStatusText({ name: "read" })).toBe("Running `read`…");
  });

  it("falls back to a generic running tool status", () => {
    expect(buildMattermostToolStatusText({ name: "exec" })).toBe("Running `exec`…");
  });
});
