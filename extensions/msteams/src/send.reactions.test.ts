import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../runtime-api.js";
import { setMSTeamsRuntime } from "./runtime.js";
import { reactMessageMSTeams, removeReactionMSTeams } from "./send.reactions.js";

// Mock graph module to avoid real Graph API calls.
vi.mock("./graph.js", () => ({
  postGraphJson: vi.fn(async () => undefined),
  resolveGraphToken: vi.fn(async () => "fake-token"),
}));

function buildMockRuntime(): PluginRuntime {
  return {
    logging: {
      getChildLogger: () => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
    },
  } as unknown as PluginRuntime;
}

const validCfg: OpenClawConfig = {
  channels: {
    msteams: {
      enabled: true,
      appId: "test-app-id",
      appPassword: "test-secret",
    },
  },
} as OpenClawConfig;

describe("reactMessageMSTeams", () => {
  beforeEach(() => {
    setMSTeamsRuntime(buildMockRuntime());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("calls postGraphJson for a valid 19: conversation ID", async () => {
    const { postGraphJson } = await import("./graph.js");
    const result = await reactMessageMSTeams({
      cfg: validCfg,
      to: "19:abc123@thread.tacv2",
      activityId: "msg-001",
      emoji: "👍",
    });
    expect(result).toEqual({ ok: true });
    expect(postGraphJson).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { reactionType: "like" },
      }),
    );
  });

  it("maps unicode emoji to Teams reaction type", async () => {
    const { postGraphJson } = await import("./graph.js");
    await reactMessageMSTeams({
      cfg: validCfg,
      to: "19:chan@thread.tacv2",
      activityId: "msg-002",
      emoji: "❤️",
    });
    expect(postGraphJson).toHaveBeenCalledWith(
      expect.objectContaining({ body: { reactionType: "heart" } }),
    );
  });

  it("passes Teams reaction type directly when already a named type", async () => {
    const { postGraphJson } = await import("./graph.js");
    await reactMessageMSTeams({
      cfg: validCfg,
      to: "19:chan@thread.tacv2",
      activityId: "msg-003",
      emoji: "laugh",
    });
    expect(postGraphJson).toHaveBeenCalledWith(
      expect.objectContaining({ body: { reactionType: "laugh" } }),
    );
  });

  it("strips conversation: prefix before constructing Graph path", async () => {
    const { postGraphJson } = await import("./graph.js");
    await reactMessageMSTeams({
      cfg: validCfg,
      to: "conversation:19:abc123@thread.tacv2",
      activityId: "msg-004b",
      emoji: "👍",
    });
    const call = (postGraphJson as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.path).toContain("19%3Aabc123%40thread.tacv2");
    expect(call.path).not.toContain("conversation%3A");
  });

  it("throws for a non-Graph-compatible conversation ID", async () => {
    await expect(
      reactMessageMSTeams({
        cfg: validCfg,
        to: "a:1XYZpersonalDM",
        activityId: "msg-004",
        emoji: "👍",
      }),
    ).rejects.toThrow("Graph-compatible");
  });
});

describe("removeReactionMSTeams", () => {
  beforeEach(() => {
    setMSTeamsRuntime(buildMockRuntime());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("calls postGraphJson /unsetReaction for a valid 19: conversation ID", async () => {
    const { postGraphJson } = await import("./graph.js");
    const result = await removeReactionMSTeams({
      cfg: validCfg,
      to: "19:abc123@thread.tacv2",
      activityId: "msg-005",
      emoji: "👍",
    });
    expect(result).toEqual({ ok: true });
    expect(postGraphJson).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { reactionType: "like" },
      }),
    );
    const call = (postGraphJson as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.path).toContain("unsetReaction");
  });

  it("strips conversation: prefix before constructing Graph path", async () => {
    const { postGraphJson } = await import("./graph.js");
    await removeReactionMSTeams({
      cfg: validCfg,
      to: "conversation:19:abc123@thread.tacv2",
      activityId: "msg-007",
      emoji: "👍",
    });
    const call = (postGraphJson as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.path).toContain("19%3Aabc123%40thread.tacv2");
    expect(call.path).not.toContain("conversation%3A");
  });

  it("throws for a non-Graph-compatible conversation ID", async () => {
    await expect(
      removeReactionMSTeams({
        cfg: validCfg,
        to: "a:1personalDM",
        activityId: "msg-006",
        emoji: "😆",
      }),
    ).rejects.toThrow("Graph-compatible");
  });
});
