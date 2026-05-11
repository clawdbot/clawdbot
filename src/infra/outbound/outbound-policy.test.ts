import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import type { ChannelMessageActionName } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { CrossContextDecoration } from "./outbound-policy.js";

let applyCrossContextDecoration: typeof import("./outbound-policy.js").applyCrossContextDecoration;
let buildCrossContextDecoration: typeof import("./outbound-policy.js").buildCrossContextDecoration;
let enforceCrossContextPolicy: typeof import("./outbound-policy.js").enforceCrossContextPolicy;
let shouldApplyCrossContextMarker: typeof import("./outbound-policy.js").shouldApplyCrossContextMarker;

function expectCrossContextDecoration(
  decoration: CrossContextDecoration | null,
): CrossContextDecoration {
  if (decoration === null) {
    throw new Error("Expected cross-context decoration");
  }
  return decoration;
}

const mocks = vi.hoisted(() => ({
  getChannelPlugin: vi.fn((channel: string) =>
    channel === "richchat"
      ? {
          messaging: {
            buildCrossContextPresentation: ({
              originLabel,
              message,
            }: {
              originLabel: string;
              message: string;
            }) => {
              const trimmed = message.trim();
              return {
                blocks: [
                  ...(trimmed ? [{ type: "text" as const, text: message }] : []),
                  { type: "context" as const, text: `From ${originLabel}` },
                ],
              };
            },
          },
        }
      : undefined,
  ),
  normalizeTargetForProvider: vi.fn((channel: string, raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      return undefined;
    }
    if (channel === "workspace") {
      return trimmed.replace(/^#/, "");
    }
    return trimmed;
  }),
  lookupDirectoryDisplay: vi.fn(async ({ targetId }: { targetId: string }) =>
    targetId.replace(/^#/, ""),
  ),
  formatTargetDisplay: vi.fn(
    ({ target, display }: { target: string; display?: string }) => display ?? target,
  ),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: mocks.getChannelPlugin,
}));

vi.mock("./target-normalization.js", () => ({
  normalizeTargetForProvider: mocks.normalizeTargetForProvider,
}));

vi.mock("./target-resolver.js", () => ({
  formatTargetDisplay: mocks.formatTargetDisplay,
  lookupDirectoryDisplay: mocks.lookupDirectoryDisplay,
}));

const workspaceConfig = {
  channels: {
    workspace: {
      botToken: "workspace-test",
      appToken: "workspace-app-test",
    },
  },
} as OpenClawConfig;

const richChatConfig = {
  channels: {
    richchat: {},
  },
} as OpenClawConfig;

function expectCrossContextPolicyResult(params: {
  cfg: OpenClawConfig;
  channel: string;
  action: "send" | "upload-file";
  to: string;
  currentChannelId: string;
  currentChannelProvider: string;
  agentId?: string;
  expected: "allow" | RegExp;
}) {
  const run = () =>
    enforceCrossContextPolicy({
      cfg: params.cfg,
      channel: params.channel,
      action: params.action,
      args: { to: params.to },
      toolContext: {
        currentChannelId: params.currentChannelId,
        currentChannelProvider: params.currentChannelProvider,
      },
      agentId: params.agentId,
    });
  if (params.expected === "allow") {
    expect(run()).toBeUndefined();
    return;
  }
  expect(run).toThrow(params.expected);
}

describe("outbound policy helpers", () => {
  beforeAll(async () => {
    ({
      applyCrossContextDecoration,
      buildCrossContextDecoration,
      enforceCrossContextPolicy,
      shouldApplyCrossContextMarker,
    } = await import("./outbound-policy.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    {
      cfg: {
        ...workspaceConfig,
        tools: {
          message: { crossContext: { allowAcrossProviders: true } },
        },
      } as OpenClawConfig,
      channel: "forum",
      action: "send" as const,
      to: "forum:@ops",
      currentChannelId: "C12345678",
      currentChannelProvider: "workspace",
      expected: "allow" as const,
    },
    {
      cfg: workspaceConfig,
      channel: "forum",
      action: "send" as const,
      to: "forum:@ops",
      currentChannelId: "C12345678",
      currentChannelProvider: "workspace",
      expected: /target provider "forum" while bound to "workspace"/,
    },
    {
      cfg: {
        ...workspaceConfig,
        tools: {
          message: { crossContext: { allowWithinProvider: false } },
        },
      } as OpenClawConfig,
      channel: "workspace",
      action: "send" as const,
      to: "C999",
      currentChannelId: "C123",
      currentChannelProvider: "workspace",
      expected: /target="C999" while bound to "C123"/,
    },
    {
      cfg: {
        ...workspaceConfig,
        tools: {
          message: { crossContext: { allowWithinProvider: false } },
        },
      } as OpenClawConfig,
      channel: "workspace",
      action: "upload-file" as const,
      to: "C999",
      currentChannelId: "C123",
      currentChannelProvider: "workspace",
      expected: /target="C999" while bound to "C123"/,
    },
    {
      cfg: {
        ...workspaceConfig,
        agents: {
          list: [
            {
              id: "sandbox",
              tools: {
                message: {
                  crossContext: {
                    allowWithinProvider: false,
                  },
                },
              },
            },
          ],
        },
      } as OpenClawConfig,
      channel: "workspace",
      action: "send" as const,
      to: "C999",
      currentChannelId: "C123",
      currentChannelProvider: "workspace",
      agentId: "sandbox",
      expected: /target="C999" while bound to "C123"/,
    },
  ])("enforces cross-context policy for %j", (params) => {
    expectCrossContextPolicyResult(params);
  });

  it("uses presentation when available and preferred", async () => {
    const decoration = await buildCrossContextDecoration({
      cfg: richChatConfig,
      channel: "richchat",
      target: "123",
      toolContext: { currentChannelId: "C12345678", currentChannelProvider: "richchat" },
    });

    const requiredDecoration = expectCrossContextDecoration(decoration);
    const applied = applyCrossContextDecoration({
      message: "hello",
      decoration: requiredDecoration,
      preferPresentation: true,
    });

    expect(applied.usedPresentation).toBe(true);
    expect(applied.presentation?.blocks.length).toBeGreaterThan(0);
    expect(applied.message).toBe("hello");
  });

  it("returns null when decoration is skipped and falls back to text markers", async () => {
    await expect(
      buildCrossContextDecoration({
        cfg: richChatConfig,
        channel: "richchat",
        target: "123",
        toolContext: {
          currentChannelId: "C12345678",
          currentChannelProvider: "richchat",
          skipCrossContextDecoration: true,
        },
      }),
    ).resolves.toBeNull();

    const applied = applyCrossContextDecoration({
      message: "hello",
      decoration: { prefix: "[from ops] ", suffix: " [cc]" },
      preferPresentation: true,
    });
    expect(applied).toEqual({
      message: "[from ops] hello [cc]",
      usedPresentation: false,
    });
  });

  it.each([
    { action: "send", expected: true },
    { action: "upload-file", expected: true },
    { action: "thread-reply", expected: true },
    { action: "thread-create", expected: false },
  ] satisfies Array<{ action: ChannelMessageActionName; expected: boolean }>)(
    "marks supported cross-context action %j",
    ({ action, expected }) => {
      expect(shouldApplyCrossContextMarker(action)).toBe(expected);
    },
  );
});
