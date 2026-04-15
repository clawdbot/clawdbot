import { ChannelType } from "@buape/carbon";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
type MaybeCreateDiscordAutoThreadFn = typeof import("./threading.js").maybeCreateDiscordAutoThread;

const { generateThreadTitleMock } = vi.hoisted(() => ({
  generateThreadTitleMock: vi.fn(),
}));

vi.mock("./thread-title.js", () => ({
  generateThreadTitle: generateThreadTitleMock,
}));

let maybeCreateDiscordAutoThread: MaybeCreateDiscordAutoThreadFn;

const postMock = vi.fn();
const getMock = vi.fn();
const patchMock = vi.fn();
const mockClient = {
  rest: { post: postMock, get: getMock, patch: patchMock },
} as unknown as Parameters<MaybeCreateDiscordAutoThreadFn>[0]["client"];
const mockMessage = {
  id: "msg1",
  timestamp: "123",
} as unknown as Parameters<MaybeCreateDiscordAutoThreadFn>[0]["message"];

function createBaseParams(
  overrides: Partial<Parameters<MaybeCreateDiscordAutoThreadFn>[0]> = {},
): Parameters<MaybeCreateDiscordAutoThreadFn>[0] {
  return {
    client: mockClient,
    message: mockMessage,
    messageChannelId: "text1",
    channel: "discord",
    isGuildMessage: true,
    channelConfig: { allowed: true, autoThread: true },
    channelType: ChannelType.GuildText,
    baseText: "test",
    combinedBody: "test",
    ...overrides,
  };
}

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
}

beforeAll(async () => {
  ({ maybeCreateDiscordAutoThread } = await import("./threading.js"));
});

beforeEach(() => {
  postMock.mockReset();
  getMock.mockReset();
  patchMock.mockReset();
  generateThreadTitleMock.mockReset();
});

describe("maybeCreateDiscordAutoThread", () => {
  it("skips auto-thread if channelType is GuildForum", async () => {
    const result = await maybeCreateDiscordAutoThread(
      createBaseParams({ channelType: ChannelType.GuildForum }),
    );
    expect(result).toBeUndefined();
    expect(postMock).not.toHaveBeenCalled();
  });

  it("skips auto-thread if channelType is GuildMedia", async () => {
    const result = await maybeCreateDiscordAutoThread(
      createBaseParams({ channelType: ChannelType.GuildMedia }),
    );
    expect(result).toBeUndefined();
    expect(postMock).not.toHaveBeenCalled();
  });

  it("skips auto-thread if channelType is GuildVoice", async () => {
    const result = await maybeCreateDiscordAutoThread(
      createBaseParams({ channelType: ChannelType.GuildVoice }),
    );
    expect(result).toBeUndefined();
    expect(postMock).not.toHaveBeenCalled();
  });

  it("skips auto-thread if channelType is GuildStageVoice", async () => {
    const result = await maybeCreateDiscordAutoThread(
      createBaseParams({ channelType: ChannelType.GuildStageVoice }),
    );
    expect(result).toBeUndefined();
    expect(postMock).not.toHaveBeenCalled();
  });

  it("creates auto-thread if channelType is GuildText", async () => {
    postMock.mockResolvedValueOnce({ id: "thread1" });
    const result = await maybeCreateDiscordAutoThread(createBaseParams());
    expect(result).toBe("thread1");
    expect(postMock).toHaveBeenCalled();
  });
});

describe("maybeCreateDiscordAutoThread autoArchiveDuration", () => {
  it("uses configured autoArchiveDuration", async () => {
    postMock.mockResolvedValueOnce({ id: "thread1" });
    await maybeCreateDiscordAutoThread(
      createBaseParams({
        channelConfig: { allowed: true, autoThread: true, autoArchiveDuration: "10080" },
      }),
    );
    expect(postMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ body: expect.objectContaining({ auto_archive_duration: 10080 }) }),
    );
  });

  it("accepts numeric autoArchiveDuration", async () => {
    postMock.mockResolvedValueOnce({ id: "thread1" });
    await maybeCreateDiscordAutoThread(
      createBaseParams({
        channelConfig: { allowed: true, autoThread: true, autoArchiveDuration: 4320 },
      }),
    );
    expect(postMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ body: expect.objectContaining({ auto_archive_duration: 4320 }) }),
    );
  });

  it("defaults to 60 when autoArchiveDuration not set", async () => {
    postMock.mockResolvedValueOnce({ id: "thread1" });
    await maybeCreateDiscordAutoThread(createBaseParams());
    expect(postMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ body: expect.objectContaining({ auto_archive_duration: 60 }) }),
    );
  });
});

describe("maybeCreateDiscordAutoThread autoThreadName", () => {
  it("renames created thread when generated mode is enabled", async () => {
    postMock.mockResolvedValueOnce({ id: "thread1" });
    patchMock.mockResolvedValueOnce({});
    generateThreadTitleMock.mockResolvedValueOnce("Deploy rollout summary");

    const cfg = { agents: { defaults: { model: "anthropic/claude-opus-4-6" } } } as OpenClawConfig;
    const result = await maybeCreateDiscordAutoThread(
      createBaseParams({
        baseText: "Need help with deploy rollout",
        combinedBody: "Need help with deploy rollout",
        channelName: "openclaw",
        channelDescription: "OpenClaw development coordination and release planning",
        channelConfig: { allowed: true, autoThread: true, autoThreadName: "generated" },
        cfg,
        agentId: "main",
      }),
    );
    expect(result).toBe("thread1");
    expect(postMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.objectContaining({ name: "Need help with deploy rollout" }),
      }),
    );
    await flushAsyncWork();
    expect(generateThreadTitleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        messageText: "Need help with deploy rollout",
        channelName: "openclaw",
        channelDescription: "OpenClaw development coordination and release planning",
      }),
    );
    expect(patchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.objectContaining({ name: "Deploy rollout summary" }),
      }),
    );
  });

  it("does not block thread creation while title summary is pending", async () => {
    postMock.mockResolvedValueOnce({ id: "thread1" });
    patchMock.mockResolvedValueOnce({});
    let resolveTitle: ((value: string | null) => void) | undefined;
    generateThreadTitleMock.mockReturnValueOnce(
      new Promise((resolve: (value: string | null) => void) => {
        resolveTitle = resolve;
      }),
    );

    const cfg = { agents: { defaults: { model: "anthropic/claude-opus-4-6" } } } as OpenClawConfig;
    const result = await maybeCreateDiscordAutoThread(
      createBaseParams({
        channelConfig: { allowed: true, autoThread: true, autoThreadName: "generated" },
        cfg,
        agentId: "main",
      }),
    );
    expect(result).toBe("thread1");
    expect(patchMock).not.toHaveBeenCalled();

    resolveTitle?.("Async summary");
    await flushAsyncWork();
    expect(patchMock).toHaveBeenCalled();
  });

  it("uses channel-specific thread override for generated title model", async () => {
    postMock.mockResolvedValueOnce({ id: "thread1" });
    patchMock.mockResolvedValueOnce({});
    generateThreadTitleMock.mockResolvedValueOnce("Deploy rollout summary");

    const cfg = {
      agents: {
        defaults: { model: "anthropic/claude-opus-4-6" },
      },
      channels: {
        modelByChannel: {
          discord: {
            thread1: "openai/gpt-4.1-mini",
          },
        },
      },
    } as OpenClawConfig;
    await maybeCreateDiscordAutoThread(
      createBaseParams({
        channelConfig: { allowed: true, autoThread: true, autoThreadName: "generated" },
        cfg,
        agentId: "main",
      }),
    );

    await flushAsyncWork();
    expect(generateThreadTitleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        modelRef: "openai/gpt-4.1-mini",
      }),
    );
  });

  it("falls back to parent channel override for generated title model", async () => {
    postMock.mockResolvedValueOnce({ id: "thread1" });
    patchMock.mockResolvedValueOnce({});
    generateThreadTitleMock.mockResolvedValueOnce("Deploy rollout summary");

    const cfg = {
      agents: {
        defaults: { model: "anthropic/claude-opus-4-6" },
      },
      channels: {
        modelByChannel: {
          discord: {
            text1: "openai/gpt-4.1-mini",
          },
        },
      },
    } as OpenClawConfig;
    await maybeCreateDiscordAutoThread(
      createBaseParams({
        channelConfig: { allowed: true, autoThread: true, autoThreadName: "generated" },
        cfg,
        agentId: "main",
      }),
    );

    await flushAsyncWork();
    expect(generateThreadTitleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        modelRef: "openai/gpt-4.1-mini",
      }),
    );
  });

  it("skips summarization when cfg or agentId is missing", async () => {
    postMock.mockResolvedValueOnce({ id: "thread1" });
    await maybeCreateDiscordAutoThread(
      createBaseParams({
        channelConfig: { allowed: true, autoThread: true, autoThreadName: "generated" },
      }),
    );
    await flushAsyncWork();
    expect(generateThreadTitleMock).not.toHaveBeenCalled();
    expect(patchMock).not.toHaveBeenCalled();
  });

  it("does not rename when autoThreadName is not set", async () => {
    postMock.mockResolvedValueOnce({ id: "thread1" });
    await maybeCreateDiscordAutoThread(
      createBaseParams({
        channelConfig: { allowed: true, autoThread: true },
      }),
    );
    await flushAsyncWork();
    expect(generateThreadTitleMock).not.toHaveBeenCalled();
    expect(patchMock).not.toHaveBeenCalled();
  });

  it("does not rename when generated title sanitizes to fallback thread name", async () => {
    postMock.mockResolvedValueOnce({ id: "thread1" });
    generateThreadTitleMock.mockResolvedValueOnce("<@123456789012345678> <#987654321098765432>");

    const cfg = { agents: { defaults: { model: "anthropic/claude-opus-4-6" } } } as OpenClawConfig;
    const result = await maybeCreateDiscordAutoThread(
      createBaseParams({
        baseText: "Need help with deploy rollout",
        combinedBody: "Need help with deploy rollout",
        channelConfig: { allowed: true, autoThread: true, autoThreadName: "generated" },
        cfg,
        agentId: "main",
      }),
    );

    expect(result).toBe("thread1");
    await flushAsyncWork();
    expect(patchMock).not.toHaveBeenCalled();
  });

  it("skips thread creation when autoThread is false", async () => {
    const result = await maybeCreateDiscordAutoThread(
      createBaseParams({
        channelConfig: { allowed: true, autoThread: false },
      }),
    );
    expect(result).toBeUndefined();
    expect(postMock).not.toHaveBeenCalled();
  });
});
