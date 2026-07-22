import { describe, expect, it, vi } from "vitest";
import { createTuiLocalization } from "./i18n/runtime.js";
import { formatStatusSummary } from "./tui-status-summary.js";

describe("formatStatusSummary localization", () => {
  it("uses the process locale at the status rendering boundary", () => {
    vi.stubEnv("OPENCLAW_LOCALE", "zh-CN");
    try {
      expect(formatStatusSummary({ sessions: { count: 0 } })[0]).toBe("网关状态");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("localizes the complete owned summary while preserving gateway data and identifiers", () => {
    const lines = formatStatusSummary(
      {
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
      },
      createTuiLocalization({ locale: "zh-CN" }),
    );
    const rendered = lines.join("\n");

    expect(rendered).toContain("网关状态");
    expect(rendered).toContain("版本：2026.7.18");
    expect(rendered).toContain("Gateway supplied channel: 已链接");
    expect(rendered).toContain("系统：\n  provider=literal-provider");
    expect(rendered).toContain("心跳：已禁用（agent-literal）");
    expect(rendered).toContain("会话存储：C:\\literal\\sessions.json");
    expect(rendered).toContain("默认模型：provider/default-model（64k 上下文）");
    expect(rendered).toContain("活动会话数：7");
    expect(rendered).toContain("agent:main:literal-session");
    expect(rendered).toContain("[direct]");
    expect(rendered).toContain("provider/model-id");
    expect(rendered).toContain("令牌数 12k/30k（剩余 18k, 40%）");
    expect(rendered).toContain("flag-literal");
    expect(rendered).toContain("排队的系统事件（1）：gateway-event-literal");
  });
});
