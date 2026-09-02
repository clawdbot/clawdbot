/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { renderComposerFixture, resetComposerFixture } from "./chat-composer.test-support.ts";

type ComposerOverrides = Parameters<typeof renderComposerFixture>[0];

function renderComposer(overrides: ComposerOverrides = {}) {
  return renderComposerFixture(overrides).container;
}

afterEach(async () => {
  await resetComposerFixture();
});

describe("renderChatComposer context usage", () => {
  it.each([
    { name: "renders the owner-selected global alias", sessionKey: "agent:work:main", owned: true },
    {
      name: "does not reuse a global row owned by another agent",
      sessionKey: "global",
      owned: false,
    },
  ])("$name", ({ sessionKey, owned }) => {
    const session: GatewaySessionRow = {
      key: "global",
      kind: "global",
      updatedAt: null,
      totalTokens: 46_000,
      contextTokens: 200_000,
    };
    const container = renderComposer({
      sessionKey,
      currentAgentId: "work",
      selectedSession: owned ? session : undefined,
      sessions: { sessions: [session], defaults: { contextTokens: 200_000 } } as never,
    });

    expect(container.querySelector(".context-ring")?.getAttribute("aria-label") ?? null).toBe(
      owned ? "Session context usage: 46k of 200k (23%)" : null,
    );
  });

  it("renders only the current session provider's plan usage", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const container = renderComposer({
      selectedSession: {
        key: "main",
        kind: "direct",
        updatedAt: null,
        totalTokens: 46_000,
        contextTokens: 200_000,
        model: "gateway-injected",
        modelProvider: "openai",
      },
      sessions: {
        sessions: [],
        defaults: { contextTokens: 200_000 },
      } as never,
      providerUsage: {
        basePath: "/control",
        modelAuthStatusResult: {
          ts: Date.now(),
          providers: [
            {
              provider: "openai",
              displayName: "OpenAI",
              status: "ok",
              profiles: [{ profileId: "openai", type: "oauth", status: "ok" }],
              usage: {
                providerId: "openai",
                windows: [
                  { label: "Week", usedPercent: 72, resetAt: 1_700_000_000_000 + 3 * 3_600_000 },
                ],
              },
            },
            {
              provider: "github-copilot",
              displayName: "Copilot",
              status: "ok",
              profiles: [{ profileId: "github-copilot", type: "token", status: "ok" }],
              usage: {
                providerId: "github-copilot",
                windows: [{ label: "Day", usedPercent: 41 }],
              },
            },
          ],
        },
      },
    });
    expect(container.querySelector(".context-ring")?.getAttribute("aria-label")).toBe(
      "Session context usage: 46k of 200k (23%)",
    );
    expect(container.querySelector(".context-usage__plan-header")?.textContent).toContain(
      "Plan usage",
    );
    expect(
      [...container.querySelectorAll(".context-usage__limit")].map((row) =>
        row.textContent?.replace(/\s+/g, " ").trim(),
      ),
    ).toEqual(["Weekly Resets 3h 72%"]);
    expect(
      container
        .querySelector("[data-chat-usage-provider='true']")
        ?.textContent?.replace(/\s+/g, " ")
        .trim(),
    ).toBe("Provider: OpenAI");
    expect(container.querySelectorAll(".context-usage__plan-header")).toHaveLength(1);
    const popoverText = container.querySelector(".context-usage__popover")?.textContent ?? "";
    expect(popoverText).not.toContain("openclaw");
    expect(popoverText).not.toContain("gateway-injected");
    expect(popoverText).not.toContain("Model:");
  });

  it("renders plan usage before session metrics arrive", () => {
    const container = renderComposer({
      sessions: null,
      messages: [{ role: "assistant", content: "hello", provider: "openai" }],
      providerUsage: {
        basePath: "/control",
        modelAuthStatusResult: {
          ts: Date.now(),
          providers: [
            {
              provider: "openai",
              displayName: "OpenAI",
              status: "ok",
              profiles: [{ profileId: "openai", type: "oauth", status: "ok" }],
              usage: { providerId: "openai", windows: [{ label: "Week", usedPercent: 72 }] },
            },
          ],
        },
      },
    });

    expect(container.querySelector(".context-ring")?.getAttribute("aria-label")).toBe(
      "Usage Remaining",
    );
    expect(container.querySelector(".context-usage__bar")).toBeNull();
    expect(container.querySelector(".context-usage__limit")?.textContent).toContain("72%");
    expect(
      container
        .querySelector<HTMLAnchorElement>("[data-chat-provider-usage='true']")
        ?.getAttribute("href"),
    ).toBe("/control/usage");
  });

  it("deduplicates provider aliases and hides cost estimates for subscriptions", () => {
    const resetAt = Date.now() + 2 * 3_600_000 + 45_000;
    const usage = {
      providerId: "anthropic",
      plan: "Max (20x)",
      windows: [
        { label: "5h", usedPercent: 22, resetAt },
        { label: "Week", usedPercent: 25 },
        { label: "Fable", usedPercent: 92 },
      ],
      billing: [{ type: "budget" as const, used: 157.85, limit: 400, unit: "USD" }],
    };
    const container = renderComposer({
      messages: [{ role: "user", content: "hi" }],
      selectedSession: {
        key: "main",
        kind: "direct",
        updatedAt: null,
        inputTokens: 2,
        outputTokens: 3,
        totalTokens: 78_700,
        contextTokens: 1_000_000,
        estimatedCostUsd: 0.02,
        model: "claude-fable-5",
        modelProvider: "anthropic",
      },
      sessions: {
        sessions: [],
        defaults: { contextTokens: 1_000_000 },
      } as never,
      providerUsage: {
        modelAuthStatusResult: {
          ts: Date.now(),
          providers: [
            {
              provider: "anthropic",
              displayName: "Claude",
              status: "ok",
              profiles: [{ profileId: "anthropic:oauth", type: "oauth", status: "ok" }],
              usage,
            },
            {
              provider: "claude-cli",
              displayName: "Claude",
              status: "ok",
              profiles: [{ profileId: "claude-cli", type: "oauth", status: "ok" }],
              usage,
            },
          ],
        },
      },
    });

    expect(container.querySelectorAll(".context-usage__plan-header")).toHaveLength(1);
    expect(container.querySelector(".context-usage__plan-badge")?.textContent).toBe("Max (20x)");
    expect(
      [...container.querySelectorAll(".context-usage__limit")].map((row) =>
        row.textContent?.replace(/\s+/g, " ").trim(),
      ),
    ).toEqual([
      "5-hour limit Resets 2h 22%",
      "Weekly 25%",
      "Fable 92%",
      "Usage credits $157.85 of $400.00",
    ]);
    expect(container.querySelector(".context-usage__stats")).not.toBeNull();
    expect(container.textContent).not.toContain("Est. cost");
  });

  it("uses response provenance only when the session provider is absent", () => {
    const session = {
      key: "main",
      kind: "direct",
      updatedAt: null,
      totalTokens: 1_000,
      contextTokens: 200_000,
      model: "gateway-injected",
      modelProvider: "openclaw" as string | undefined,
    };
    const composerProps = {
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "hello",
          cost: { input: 0.01, output: 0.02 },
          provider: "openai",
          responseModel: "gpt-5.5",
        },
      ],
      selectedSession: session,
      sessions: {
        sessions: [session],
        defaults: { contextTokens: 200_000 },
      },
      providerUsage: {
        modelAuthStatusResult: {
          ts: Date.now(),
          providers: [
            {
              provider: "anthropic",
              displayName: "Claude",
              status: "ok",
              profiles: [{ profileId: "anthropic:oauth", type: "oauth", status: "ok" }],
              usage: {
                providerId: "anthropic",
                windows: [{ label: "Week", usedPercent: 25 }],
              },
            },
            {
              provider: "openai",
              displayName: "OpenAI",
              status: "ok",
              profiles: [{ profileId: "openai", type: "oauth", status: "ok" }],
              usage: {
                providerId: "openai",
                windows: [{ label: "Week", usedPercent: 72 }],
              },
            },
          ],
        },
      },
    };
    const providerNames = (container: HTMLElement) =>
      [...container.querySelectorAll("[data-chat-usage-provider='true']")].map((row) =>
        row.textContent?.replace(/\s+/g, " ").trim(),
      );

    const container = renderComposer(composerProps as never);

    expect(providerNames(container)).toEqual([]);
    expect(container.textContent).toContain("Cost by Type");
    expect(container.textContent).not.toContain("Model:");

    session.modelProvider = undefined;
    expect(providerNames(renderComposer(composerProps as never))).toEqual(["Provider: OpenAI"]);
  });

  it("keeps context, token, and cost details when only unrelated plan usage exists", () => {
    const container = renderComposer({
      selectedSession: {
        key: "main",
        kind: "direct",
        updatedAt: null,
        inputTokens: 800,
        outputTokens: 200,
        totalTokens: 46_000,
        contextTokens: 200_000,
        estimatedCostUsd: 0.03,
        modelProvider: "openai",
      },
      sessions: {
        sessions: [],
        defaults: { contextTokens: 200_000 },
      } as never,
      providerUsage: {
        modelAuthStatusResult: {
          ts: Date.now(),
          providers: [
            {
              provider: "github-copilot",
              displayName: "Copilot",
              status: "ok",
              profiles: [{ profileId: "github-copilot", type: "token", status: "ok" }],
              usage: {
                providerId: "github-copilot",
                windows: [{ label: "Day", usedPercent: 41 }],
              },
            },
          ],
        },
      },
    });

    const popoverText = container.querySelector(".context-usage__popover")?.textContent ?? "";
    expect(container.querySelector(".context-usage__plan-header")).toBeNull();
    expect(popoverText).not.toContain("Copilot");
    expect(popoverText).toContain("Context window");
    expect(popoverText).toContain("Latest run tokens");
    expect(popoverText).toContain("Est. cost");
    expect(popoverText).toContain("$0.03");
  });

  it("omits the cost-by-type section when every recorded cost is zero", () => {
    const container = renderComposer({
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "hello",
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          provider: "openai",
          responseModel: "gpt-zero",
        },
        {
          role: "assistant",
          content: "hello",
          model: "gateway-injected",
          provider: "openclaw",
          usage: {
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      ],
      selectedSession: {
        key: "main",
        kind: "direct",
        updatedAt: null,
        totalTokens: 1_000,
        contextTokens: 200_000,
      },
      sessions: {
        sessions: [],
        defaults: { contextTokens: 200_000 },
      } as never,
    });

    expect(container.textContent).not.toContain("Cost by Type");
  });

  it("prioritizes a matching session provider over historical response provenance", () => {
    const container = renderComposer({
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "hello",
          cost: { input: 0.01, output: 0.02 },
          provider: "openai",
          responseModel: "gpt-5.5",
        },
      ],
      selectedSession: {
        key: "main",
        kind: "direct",
        updatedAt: null,
        totalTokens: 1_000,
        contextTokens: 200_000,
        modelProvider: "anthropic",
      },
      sessions: {
        sessions: [],
        defaults: { contextTokens: 200_000 },
      } as never,
      providerUsage: {
        modelAuthStatusResult: {
          ts: Date.now(),
          providers: [
            {
              provider: "openai",
              displayName: "OpenAI",
              status: "ok",
              profiles: [{ profileId: "openai", type: "oauth", status: "ok" }],
              usage: {
                providerId: "openai",
                windows: [{ label: "Week", usedPercent: 72 }],
              },
            },
            {
              provider: "claude-cli",
              displayName: "Claude",
              status: "ok",
              profiles: [{ profileId: "claude-cli", type: "oauth", status: "ok" }],
              usage: {
                providerId: "anthropic",
                windows: [{ label: "Week", usedPercent: 25 }],
              },
            },
          ],
        },
      },
    });

    expect(
      [...container.querySelectorAll(".context-usage__limit")].map((row) =>
        row.textContent?.replace(/\s+/g, " ").trim(),
      ),
    ).toEqual(["Weekly 25%"]);
    expect(
      [...container.querySelectorAll("[data-chat-usage-provider='true']")].map((row) =>
        row.textContent?.replace(/\s+/g, " ").trim(),
      ),
    ).toEqual(["Provider: Claude"]);
    expect(container.textContent).not.toContain("Model:");
  });

  it("warns on fresh high usage but keeps stale usage approximate", () => {
    let container = renderComposer({
      selectedSession: {
        key: "main",
        kind: "direct",
        updatedAt: null,
        totalTokens: 190_000,
        contextTokens: 200_000,
      },
      sessions: {
        sessions: [],
        defaults: { contextTokens: 200_000 },
      } as never,
    });
    const contextRing = container.querySelector(".context-ring");
    expect(contextRing?.getAttribute("aria-label")).toBe(
      "Session context usage: 190k of 200k (95%)",
    );
    expect(contextRing?.classList).toContain("context-ring--warning");
    expect(container.textContent).not.toContain("Compact");

    container = renderComposer({
      selectedSession: {
        key: "main",
        kind: "direct",
        updatedAt: null,
        totalTokens: 190_000,
        totalTokensFresh: false,
        contextTokens: 200_000,
      },
      sessions: {
        sessions: [],
        defaults: { contextTokens: 200_000 },
      } as never,
    });
    expect(container.querySelector(".context-ring")?.getAttribute("aria-label")).toBe(
      "Session context usage: ~190k of 200k (~95%)",
    );
    expect(container.querySelector(".context-ring")?.classList).not.toContain(
      "context-ring--warning",
    );
  });
});
