import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import type { ChannelMessageActionName } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";

let applyCrossContextDecoration: typeof import("./outbound-policy.js").applyCrossContextDecoration;
let buildCrossContextDecoration: typeof import("./outbound-policy.js").buildCrossContextDecoration;
let enforceCrossContextPolicy: typeof import("./outbound-policy.js").enforceCrossContextPolicy;
let shouldApplyCrossContextMarker: typeof import("./outbound-policy.js").shouldApplyCrossContextMarker;

class TestTextDisplay {
  constructor(readonly content: string) {}
}

class TestSeparator {
  constructor(readonly options: { divider: boolean; spacing: string }) {}
}

class TestDiscordUiContainer {
  constructor(readonly components: Array<TestTextDisplay | TestSeparator>) {}
}

const mocks = vi.hoisted(() => ({
  getChannelMessageAdapter: vi.fn((channel: string) =>
    channel === "discord"
      ? {
          supportsComponentsV2: true,
          buildCrossContextComponents: ({
            originLabel,
            message,
          }: {
            originLabel: string;
            message: string;
          }) => {
            const trimmed = message.trim();
            const components: Array<TestTextDisplay | TestSeparator> = [];
            if (trimmed) {
              components.push(new TestTextDisplay(message));
              components.push(new TestSeparator({ divider: true, spacing: "small" }));
            }
            components.push(new TestTextDisplay(`*From ${originLabel}*`));
            return [new TestDiscordUiContainer(components)];
          },
        }
      : { supportsComponentsV2: false },
  ),
  normalizeTargetForProvider: vi.fn((channel: string, raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      return undefined;
    }
    if (channel === "slack") {
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

vi.mock("./channel-adapters.js", () => ({
  getChannelMessageAdapter: mocks.getChannelMessageAdapter,
}));

vi.mock("./target-normalization.js", () => ({
  normalizeTargetForProvider: mocks.normalizeTargetForProvider,
}));

vi.mock("./target-resolver.js", () => ({
  formatTargetDisplay: mocks.formatTargetDisplay,
  lookupDirectoryDisplay: mocks.lookupDirectoryDisplay,
}));

const slackConfig = {
  channels: {
    slack: {
      botToken: "xoxb-test",
      appToken: "xapp-test",
    },
  },
} as OpenClawConfig;

const discordConfig = {
  channels: {
    discord: {},
  },
} as OpenClawConfig;

function expectCrossContextPolicyResult(params: {
  cfg: OpenClawConfig;
  channel: string;
  action: "send" | "upload-file";
  to: string;
  currentChannelId: string;
  currentChannelProvider: string;
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
    });
  if (params.expected === "allow") {
    expect(run).not.toThrow();
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
        ...slackConfig,
        tools: {
          message: { crossContext: { allowAcrossProviders: true } },
        },
      } as OpenClawConfig,
      channel: "telegram",
      action: "send" as const,
      to: "telegram:@ops",
      currentChannelId: "C12345678",
      currentChannelProvider: "slack",
      expected: "allow" as const,
    },
    {
      cfg: slackConfig,
      channel: "telegram",
      action: "send" as const,
      to: "telegram:@ops",
      currentChannelId: "C12345678",
      currentChannelProvider: "slack",
      expected: /target provider "telegram" while bound to "slack"/,
    },
    {
      cfg: {
        ...slackConfig,
        tools: {
          message: { crossContext: { allowWithinProvider: false } },
        },
      } as OpenClawConfig,
      channel: "slack",
      action: "send" as const,
      to: "C999",
      currentChannelId: "C123",
      currentChannelProvider: "slack",
      expected: /target="C999" while bound to "C123"/,
    },
    {
      cfg: {
        ...slackConfig,
        tools: {
          message: { crossContext: { allowWithinProvider: false } },
        },
      } as OpenClawConfig,
      channel: "slack",
      action: "upload-file" as const,
      to: "C999",
      currentChannelId: "C123",
      currentChannelProvider: "slack",
      expected: /target="C999" while bound to "C123"/,
    },
  ])("enforces cross-context policy for %j", (params) => {
    expectCrossContextPolicyResult(params);
  });

  it("uses components when available and preferred", async () => {
    const decoration = await buildCrossContextDecoration({
      cfg: discordConfig,
      channel: "discord",
      target: "123",
      toolContext: { currentChannelId: "C12345678", currentChannelProvider: "discord" },
    });

    expect(decoration).not.toBeNull();
    const applied = applyCrossContextDecoration({
      message: "hello",
      decoration: decoration!,
      preferComponents: true,
    });

    expect(applied.usedComponents).toBe(true);
    expect(applied.componentsBuilder).toBeDefined();
    expect(applied.componentsBuilder?.("hello").length).toBeGreaterThan(0);
    expect(applied.message).toBe("hello");
  });

  it("returns null when decoration is skipped and falls back to text markers", async () => {
    await expect(
      buildCrossContextDecoration({
        cfg: discordConfig,
        channel: "discord",
        target: "123",
        toolContext: {
          currentChannelId: "C12345678",
          currentChannelProvider: "discord",
          skipCrossContextDecoration: true,
        },
      }),
    ).resolves.toBeNull();

    const applied = applyCrossContextDecoration({
      message: "hello",
      decoration: { prefix: "[from ops] ", suffix: " [cc]" },
      preferComponents: true,
    });
    expect(applied).toEqual({
      message: "[from ops] hello [cc]",
      usedComponents: false,
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
