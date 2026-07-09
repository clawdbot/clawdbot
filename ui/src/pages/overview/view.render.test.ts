/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";
import { renderOverview } from "./view.ts";

type OverviewProps = Parameters<typeof renderOverview>[0];

function createOverviewProps(overrides: Partial<OverviewProps> = {}): OverviewProps {
  return {
    connected: false,
    hello: null,
    settings: {
      gatewayUrl: "",
      token: "",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "system",
      chatShowThinking: true,
      chatShowToolCalls: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 258,
      sidebarPinnedRoutes: ["overview"],
      sidebarMoreExpanded: false,
      locale: "en",
    },
    password: "",
    lastError: null,
    lastChannelsRefresh: null,
    modelAuthStatus: null,
    usageResult: null,
    sessionsResult: null,
    skillsReport: null,
    cronJobs: [],
    cronStatus: null,
    attentionItems: [],
    eventLog: [],
    overviewLogLines: [],
    showGatewayToken: false,
    showGatewayPassword: false,
    onConnectionChange: () => undefined,
    onLocaleChange: () => undefined,
    onPasswordChange: () => undefined,
    onSessionKeyChange: () => undefined,
    onToggleGatewayTokenVisibility: () => undefined,
    onToggleGatewayPasswordVisibility: () => undefined,
    onConnect: () => undefined,
    onRefresh: () => undefined,
    onNavigate: () => undefined,
    canNavigate: () => true,
    onRefreshLogs: () => undefined,
    ...overrides,
  };
}

function compactText(node: Element | null): string | undefined {
  return node?.textContent?.trim().replace(/\s+/g, " ");
}

describe("overview view rendering", () => {
  it("keeps the persisted overview locale selected before i18n hydration finishes", async () => {
    const container = document.createElement("div");
    const props = createOverviewProps({
      settings: {
        ...createOverviewProps().settings,
        locale: "zh-CN",
      },
    });

    getSafeLocalStorage()?.clear();
    await i18n.setLocale("en");

    render(renderOverview(props), container);
    await Promise.resolve();

    let select = container.querySelector<HTMLSelectElement>("select");
    expect(i18n.getLocale()).toBe("en");
    expect(select?.value).toBe("zh-CN");
    expect(select?.selectedOptions[0]?.textContent?.trim()).toBe("简体中文 (Simplified Chinese)");

    await i18n.setLocale("zh-CN");
    render(renderOverview(props), container);
    await Promise.resolve();

    select = container.querySelector<HTMLSelectElement>("select");
    expect(select?.value).toBe("zh-CN");
    expect(select?.selectedOptions[0]?.textContent?.trim()).toBe("简体中文 (简体中文)");

    await i18n.setLocale("en");
  });

  it("renders recent session names through the shared display resolver", async () => {
    const container = document.createElement("div");
    const props = createOverviewProps({
      sessionsResult: {
        ts: 0,
        path: "",
        count: 3,
        defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
        sessions: [
          {
            key: "discord:123:456",
            kind: "direct",
            label: "   ",
            displayName: "Ops Room",
            model: "gpt-5",
            updatedAt: null,
          },
          {
            key: "telegram:123:456",
            kind: "direct",
            label: "telegram:123:456",
            model: "gpt-5",
            updatedAt: null,
          },
          {
            key: "agent:main:main",
            kind: "direct",
            label: "Main Project",
            displayName: "agent:main:main",
            model: "gpt-5",
            updatedAt: null,
          },
        ],
      },
    });

    render(renderOverview(props), container);
    await Promise.resolve();

    const recentNames = [...container.querySelectorAll(".ov-recent__key")].map(
      (node) => node.textContent?.trim() ?? "",
    );
    expect(recentNames).toEqual(["Ops Room", "Telegram Session", "Main Project"]);
    expect(recentNames).not.toContain("telegram:123:456");
  });

  it("promotes provider quota into a dedicated overview card", async () => {
    const container = document.createElement("div");
    const props = createOverviewProps({
      usageResult: {
        totals: { totalCost: 0, totalTokens: 0 },
        aggregates: { messages: { total: 0 } },
      } as OverviewProps["usageResult"],
      modelAuthStatus: {
        ts: Date.now(),
        providers: [
          {
            provider: "openai",
            displayName: "Codex",
            status: "ok",
            profiles: [{ profileId: "codex", type: "oauth", status: "ok" }],
            usage: {
              providerId: "openai",
              windows: [
                { label: "3h", usedPercent: 18 },
                { label: "Week", usedPercent: 72 },
              ],
            },
          },
          {
            provider: "anthropic",
            displayName: "Claude",
            status: "ok",
            profiles: [{ profileId: "anthropic", type: "token", status: "ok" }],
            usage: {
              providerId: "anthropic",
              windows: [{ label: "5h", usedPercent: 60 }],
            },
          },
        ],
      },
    });

    render(renderOverview(props), container);
    await Promise.resolve();

    const quota = container.querySelector('[data-kind="quota"]');
    expect(compactText(quota)).toBe("Usage 28% left Codex · Week · Claude · 5h 40% left");
  });
});
