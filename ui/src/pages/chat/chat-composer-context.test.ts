/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderComposerFixture, resetComposerFixture } from "./chat-composer.test-support.ts";

type ComposerOverrides = Parameters<typeof renderComposerFixture>[0];

function renderComposer(overrides: ComposerOverrides = {}) {
  return renderComposerFixture(overrides).container;
}

afterEach(async () => {
  await resetComposerFixture();
});

describe("renderChatComposer context usage", () => {
  it("renders session context and plan usage through the full composer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const container = renderComposer({
      sessions: {
        sessions: [
          {
            key: "main",
            kind: "direct",
            updatedAt: null,
            totalTokens: 46_000,
            contextTokens: 200_000,
            model: "gateway-injected",
            modelProvider: "openclaw",
          },
        ],
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
    const popoverText = container.querySelector(".context-usage__popover")?.textContent ?? "";
    expect(popoverText).not.toContain("openclaw");
    expect(popoverText).not.toContain("gateway-injected");
    expect(popoverText).not.toContain("Model:");
  });

  it("renders plan usage before session metrics arrive", () => {
    const container = renderComposer({
      sessions: null,
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
      sessions: {
        sessions: [
          {
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
        ],
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

    expect(providerNames(container)).toEqual(["Provider: Claude", "Provider: OpenAI"]);
    expect(container.textContent).toContain("Cost by Type");
    expect(container.textContent).not.toContain("Model:");

    session.modelProvider = undefined;
    expect(providerNames(renderComposer(composerProps as never))).toEqual([
      "Provider: OpenAI",
      "Provider: Claude",
    ]);
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
      sessions: {
        sessions: [
          {
            key: "main",
            kind: "direct",
            updatedAt: null,
            totalTokens: 1_000,
            contextTokens: 200_000,
          },
        ],
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
      sessions: {
        sessions: [
          {
            key: "main",
            kind: "direct",
            updatedAt: null,
            totalTokens: 1_000,
            contextTokens: 200_000,
            modelProvider: "anthropic",
          },
        ],
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
    ).toEqual(["Weekly 25%", "Weekly 72%"]);
    expect(
      [...container.querySelectorAll("[data-chat-usage-provider='true']")].map((row) =>
        row.textContent?.replace(/\s+/g, " ").trim(),
      ),
    ).toEqual(["Provider: Claude", "Provider: OpenAI"]);
    expect(container.textContent).not.toContain("Model:");
  });

  it("warns on fresh high usage but keeps stale usage approximate and nonactionable", () => {
    const onCompact = vi.fn();
    let container = renderComposer({
      onCompact,
      sessions: {
        sessions: [
          {
            key: "main",
            kind: "direct",
            updatedAt: null,
            totalTokens: 190_000,
            contextTokens: 200_000,
          },
        ],
        defaults: { contextTokens: 200_000 },
      } as never,
    });
    const compact = container.querySelector<HTMLButtonElement>(".context-ring__compact");
    expect(compact?.getAttribute("aria-label")).toContain(
      "Session context usage: 190k of 200k (95%)",
    );
    expect(container.querySelector(".context-ring")).toBeNull();
    expect(compact?.textContent).toContain("Compact");
    compact?.click();
    expect(onCompact).toHaveBeenCalledOnce();

    container = renderComposer({
      onCompact,
      sessions: {
        sessions: [
          {
            key: "main",
            kind: "direct",
            updatedAt: null,
            totalTokens: 190_000,
            totalTokensFresh: false,
            contextTokens: 200_000,
          },
        ],
        defaults: { contextTokens: 200_000 },
      } as never,
    });
    expect(container.querySelector(".context-ring")?.getAttribute("aria-label")).toBe(
      "Session context usage: ~190k of 200k (~95%)",
    );
    expect(container.querySelector(".context-ring")?.classList).not.toContain(
      "context-ring--warning",
    );
    expect(container.querySelector(".context-ring__compact")).toBeNull();
  });
});
