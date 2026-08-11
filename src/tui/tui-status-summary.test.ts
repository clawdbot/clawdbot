import { describe, expect, it, vi } from "vitest";
import { createTuiLocalization } from "./i18n/runtime.js";
import { formatStatusSummary } from "./tui-status-summary.js";
import type { GatewayStatusSummary } from "./tui-types.js";

function representativeSummary(): GatewayStatusSummary {
  return {
    runtimeVersion: "2026.7.18",
    linkChannel: {
      label: "Gateway supplied channel",
      linked: true,
      authAgeMs: 60_000,
    },
    providerSummary: ["provider=literal-provider"],
    heartbeat: {
      agents: [{ agentId: "agent-literal", enabled: false }],
    },
    sessions: {
      paths: ["C:\\literal\\sessions.json"],
      defaults: { model: "provider/default-model", contextTokens: 64_000 },
      count: 7,
      recent: [
        {
          key: "agent:main:literal-session",
          kind: "direct",
          age: 3_600_000,
          model: "provider/model-id",
          totalTokens: 12_000,
          contextTokens: 30_000,
          remainingTokens: 18_000,
          percentUsed: 40,
          flags: ["flag-literal"],
        },
      ],
    },
    queuedSystemEvents: ["gateway-event-literal"],
  };
}

function recentAgeLabel(age?: number | null, locale: "en" | "zh-CN" = "en"): string {
  const lines = formatStatusSummary(
    {
      sessions: {
        count: 1,
        recent: [{ key: "agent:main:age-edge", ...(age === undefined ? {} : { age }) }],
      },
    },
    createTuiLocalization({ locale }),
  );
  return lines.find((line) => line.startsWith("- ")) ?? "";
}

describe("formatStatusSummary localization", () => {
  it("uses the process locale at the status rendering boundary", () => {
    vi.stubEnv("OPENCLAW_LOCALE", "zh-CN");
    try {
      const localization = createTuiLocalization();
      expect(formatStatusSummary({ sessions: { count: 0 } }, localization)[0]).toBe("网关状态");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("preserves the complete reviewed English status summary", () => {
    expect(
      formatStatusSummary(representativeSummary(), createTuiLocalization({ locale: "en" })),
    ).toEqual([
      "Gateway status",
      "Version: 2026.7.18",
      "Gateway supplied channel: linked (last refreshed 1m ago)",
      "",
      "System:",
      "  provider=literal-provider",
      "",
      "Heartbeat: disabled (agent-literal)",
      "Session store: C:\\literal\\sessions.json",
      "Default model: provider/default-model (64k ctx)",
      "Active sessions: 7",
      "Recent sessions:",
      "- agent:main:literal-session [direct] | 1h ago | model provider/model-id | tokens 12k/30k (18k left, 40%) | flags: flag-literal",
      "Queued system events (1): gateway-event-literal",
    ]);
  });

  it("localizes the complete owned summary while preserving gateway data and identifiers", () => {
    const rendered = formatStatusSummary(
      representativeSummary(),
      createTuiLocalization({ locale: "zh-CN" }),
    ).join("\n");

    expect(rendered).toContain("网关状态");
    expect(rendered).toContain("版本：2026.7.18");
    expect(rendered).toContain("Gateway supplied channel: 已链接（上次刷新于 1 分钟前）");
    expect(rendered).toContain("系统：\n  provider=literal-provider");
    expect(rendered).toContain("心跳：已禁用（agent-literal）");
    expect(rendered).toContain("会话存储：C:\\literal\\sessions.json");
    expect(rendered).toContain("默认模型：provider/default-model（64k 上下文）");
    expect(rendered).toContain("活动会话数：7");
    expect(rendered).toContain("agent:main:literal-session");
    expect(rendered).toContain("[direct]");
    expect(rendered).toContain("1 小时前");
    expect(rendered).toContain("provider/model-id");
    expect(rendered).toContain("令牌数 12k/30k（剩余 18k, 40%）");
    expect(rendered).toContain("flag-literal");
    expect(rendered).toContain("排队的系统事件（1）：gateway-event-literal");
  });

  it.each([
    { name: "zero", age: 0, english: "just now", chinese: "刚刚" },
    { name: "below minute rounding", age: 29_499, english: "just now", chinese: "刚刚" },
    { name: "minute threshold", age: 29_500, english: "1m ago", chinese: "1 分钟前" },
    { name: "below hour rounding", age: 3_569_000, english: "59m ago", chinese: "59 分钟前" },
    { name: "hour threshold", age: 3_570_000, english: "1h ago", chinese: "1 小时前" },
    { name: "below day rounding", age: 170_940_000, english: "47h ago", chinese: "47 小时前" },
    { name: "day threshold", age: 171_000_000, english: "2d ago", chinese: "2 天前" },
    { name: "negative", age: -1, english: "unknown", chinese: "未知" },
    { name: "non-finite", age: Number.POSITIVE_INFINITY, english: "unknown", chinese: "未知" },
  ])("uses shared age buckets at the $name edge", ({ age, english, chinese }) => {
    expect(recentAgeLabel(age, "en")).toContain(`| ${english} |`);
    expect(recentAgeLabel(age, "zh-CN")).toContain(`| ${chinese} |`);
  });

  it("distinguishes a missing age from an invalid reported age", () => {
    expect(recentAgeLabel(undefined, "en")).toContain("| no activity |");
    expect(recentAgeLabel(undefined, "zh-CN")).toContain("| 无活动 |");
  });
});
