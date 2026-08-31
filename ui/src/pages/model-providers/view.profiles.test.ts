/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { button, card, mount, props, text } from "./view.test-support.ts";

describe("renderModelProviders profiles", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    for (const container of document.body.querySelectorAll("div")) {
      render(nothing, container);
    }
    document.body.replaceChildren();
  });

  it("confirms one profile logout from its quiet icon action", () => {
    const profileCard = card({
      credentialProviderIds: ["openai", "agent-openai-alias"],
      logoutTargets: [{ provider: "agent-openai-alias", profileIds: ["openai:oauth"] }],
      profileProviderIds: { "openai:oauth": "openai" },
      profileOrders: { openai: ["openai:oauth"] },
      profiles: [
        {
          profileId: "openai:oauth",
          type: "oauth",
          status: "ok",
          logoutSupported: true,
          email: "owner@example.com",
        },
      ],
    });
    const onRequestLogout = vi.fn();
    const container = mount(props({ cards: [profileCard], onRequestLogout }));
    expect(container.querySelector(".model-providers__confirm")).toBeNull();
    container.querySelector<HTMLButtonElement>('[aria-label="Log out owner@example.com"]')?.click();
    const pendingLogout = {
      cardId: "openai",
      label: "owner@example.com",
      targets: [{ provider: "agent-openai-alias", profileIds: ["openai:oauth"] }],
    };
    expect(onRequestLogout).toHaveBeenCalledWith(pendingLogout);

    const onLogout = vi.fn();
    const confirmation = mount(props({ cards: [profileCard], pendingLogout, onLogout }));
    button(confirmation, "Log out")?.click();
    expect(onLogout).toHaveBeenCalledWith("openai", pendingLogout.targets);
  });

  it("renders every account quota window, billing fact, and usage failure", () => {
    const container = mount(
      props({
        cards: [
          card({
            profiles: [
              {
                profileId: "openai:first",
                type: "oauth",
                status: "ok",
                email: "first@example.com",
                usage: {
                  providerId: "openai",
                  plan: "Pro",
                  windows: [
                    { label: "5h", usedPercent: 25 },
                    { label: "Weekly", usedPercent: 10 },
                  ],
                  billing: [{ type: "balance", amount: 12, unit: "credits" }],
                },
              },
              {
                profileId: "openai:second",
                type: "oauth",
                status: "expired",
                email: "second@example.com",
                usage: {
                  providerId: "openai",
                  windows: [],
                  error: "Refresh token rejected",
                },
              },
            ],
            profileProviderIds: {
              "openai:first": "openai",
              "openai:second": "openai",
            },
            profileOrders: { openai: ["openai:first", "openai:second"] },
          }),
        ],
      }),
    );
    const rows = container.querySelectorAll(".model-providers__profile");

    expect(rows[0]?.querySelectorAll('[role="progressbar"]')).toHaveLength(2);
    expect(text(rows[0] ?? null)).toContain("Pro");
    expect(text(rows[0] ?? null)).toContain("12 credits");
    expect(text(rows[1] ?? null)).toContain("Refresh token rejected");
    expect(container.querySelector(".model-providers__global-metrics")).toBeNull();
  });

  it("shows an account-scoped plan only on its profile row", () => {
    const container = mount(
      props({
        cards: [
          card({
            apiKey: { source: "config" },
            localCost: { totalCost: 12, totalTokens: 1_000, sessionCount: 2 },
            profiles: [
              {
                profileId: "openai:first",
                type: "oauth",
                status: "ok",
                usage: {
                  providerId: "openai",
                  plan: "Pro",
                  windows: [{ label: "Weekly", usedPercent: 10 }],
                },
              },
              { profileId: "openai:second", type: "oauth", status: "ok" },
            ],
          }),
        ],
      }),
    );

    expect(text(container).match(/\bPro\b/gu)).toHaveLength(1);
    expect(text(container.querySelector(".model-providers__profile"))).toContain("Pro");
    expect(text(container.querySelector(".settings-row__control"))).not.toContain("Pro");
    const sessionSummary = container.querySelector(".model-providers__local-cost");
    const profiles = container.querySelector(".model-providers__profiles");
    expect(text(sessionSummary)).toContain("Session spend · 30d");
    expect(text(sessionSummary)).not.toContain("Weekly");
    expect(sessionSummary?.compareDocumentPosition(profiles ?? container)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(container.querySelector(".model-providers__global-metrics")).toBeNull();
  });

  it("keeps unmatched account usage visible beside profile usage", () => {
    const container = mount(
      props({
        cards: [
          card({
            usageScope: "account",
            usage: {
              provider: "openai",
              displayName: "OpenAI",
              accountEmail: "other@example.com",
              windows: [{ label: "Other account week", usedPercent: 55 }],
            },
            profiles: [
              {
                profileId: "openai:first",
                type: "oauth",
                status: "ok",
                email: "first@example.com",
                usage: {
                  providerId: "openai",
                  windows: [{ label: "Profile week", usedPercent: 10 }],
                },
              },
            ],
          }),
        ],
      }),
    );

    expect(text(container.querySelector(".model-providers__profile-usage"))).toContain(
      "Profile week",
    );
    expect(text(container.querySelector(".model-providers__global-metrics"))).toContain(
      "Other account week",
    );
  });

  it("distinguishes pending account usage from an unsupported usage source", () => {
    const pending = mount(
      props({
        cards: [
          card({
            profiles: [
              {
                profileId: "openai:first",
                type: "oauth",
                status: "ok",
                usageRefreshPending: true,
              },
              { profileId: "openai:second", type: "oauth", status: "ok" },
            ],
          }),
        ],
      }),
    );
    const pendingUsage = pending.querySelectorAll(".model-providers__profile-usage");
    expect(text(pendingUsage[0] ?? null)).toContain("Loading");
    expect(text(pendingUsage[1] ?? null)).toContain("No live usage data reported");

    const unsupported = mount(
      props({
        cards: [
          card({
            profiles: [{ profileId: "openai:first", type: "oauth", status: "ok" }],
          }),
        ],
      }),
    );
    expect(text(unsupported.querySelector(".model-providers__profile-usage"))).toContain(
      "No live usage data reported",
    );

    const planOnly = mount(
      props({
        cards: [
          card({
            profiles: [
              {
                profileId: "openai:first",
                type: "oauth",
                status: "ok",
                usage: { providerId: "openai", plan: "Pro", windows: [] },
              },
            ],
          }),
        ],
      }),
    );
    expect(text(planOnly)).toContain("Pro");
    expect(text(planOnly)).not.toContain("No live usage data reported");
  });

  it("marks cached account usage as refreshing without hiding it", () => {
    const container = mount(
      props({
        cards: [
          card({
            profiles: [
              {
                profileId: "openai:first",
                type: "oauth",
                status: "ok",
                usageRefreshPending: true,
                usage: {
                  providerId: "openai",
                  windows: [{ label: "Weekly", usedPercent: 25 }],
                },
              },
            ],
          }),
        ],
      }),
    );
    const usage = container.querySelector(".model-providers__profile-usage");

    expect(usage?.getAttribute("aria-busy")).toBe("true");
    expect(text(usage)).toContain("Weekly");
    expect(text(usage)).toContain("Refreshing");
  });

  it("reorders profiles from the keyboard even while provider data refreshes", () => {
    const onProfileOrderChange = vi.fn();
    const container = mount(
      props({
        refreshing: true,
        cards: [
          card({
            profiles: [
              { profileId: "openai:one", type: "oauth", status: "ok", email: "one@example.com" },
              { profileId: "openai:two", type: "oauth", status: "ok", email: "two@example.com" },
            ],
            profileProviderIds: {
              "openai:one": "openai",
              "openai:two": "openai",
            },
            profileOrders: { openai: ["openai:one", "openai:two"] },
          }),
        ],
        onProfileOrderChange,
      }),
    );
    const secondGrip = container.querySelectorAll<HTMLButtonElement>(
      ".model-providers__profile-grip",
    )[1];

    secondGrip?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));

    expect(secondGrip?.disabled).toBe(false);
    expect(onProfileOrderChange).toHaveBeenCalledWith("openai", "openai", [
      "openai:two",
      "openai:one",
    ]);
  });

  it("disables reordering when a stored order omits visible profiles", () => {
    const onProfileOrderChange = vi.fn();
    const container = mount(
      props({
        cards: [
          card({
            profiles: [
              { profileId: "openai:one", type: "oauth", status: "ok" },
              { profileId: "openai:two", type: "oauth", status: "ok" },
              { profileId: "openai:excluded", type: "oauth", status: "ok" },
            ],
            profileProviderIds: {
              "openai:one": "openai",
              "openai:two": "openai",
              "openai:excluded": "openai",
            },
            profileOrders: { openai: ["openai:one", "openai:two"] },
            profileOrderStoredProviders: ["openai"],
          }),
        ],
        onProfileOrderChange,
      }),
    );
    const grips = container.querySelectorAll<HTMLButtonElement>(".model-providers__profile-grip");

    expect([...grips].every((grip) => grip.disabled)).toBe(true);
    expect(grips[0]?.title).toContain("Reset");
    grips[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));

    expect(onProfileOrderChange).not.toHaveBeenCalled();
  });

  it("removes reorder controls when priority rotates across provider routes", () => {
    const onProfileOrderChange = vi.fn();
    const sharedOrder = ["shared:one", "shared:two", "shared:three"];
    const container = mount(
      props({
        cards: [
          card({
            id: "route-one",
            profiles: [
              { profileId: "shared:one", type: "oauth", status: "ok" },
              { profileId: "shared:two", type: "oauth", status: "ok" },
            ],
            profileProviderIds: {
              "shared:one": "shared-owner",
              "shared:two": "shared-owner",
            },
            profileOrders: { "shared-owner": sharedOrder },
          }),
          card({
            id: "route-two",
            profiles: [{ profileId: "shared:three", type: "oauth", status: "ok" }],
            profileProviderIds: { "shared:three": "shared-owner" },
            profileOrders: { "shared-owner": sharedOrder },
          }),
        ],
        onProfileOrderChange,
      }),
    );
    expect(container.querySelectorAll(".model-providers__profile-grip")).toHaveLength(0);
    expect(container.querySelectorAll(".model-providers__profile-grip-spacer")).toHaveLength(3);
    expect(container.textContent).toContain("Priority rotates automatically across provider routes");

    expect(onProfileOrderChange).not.toHaveBeenCalled();
  });

  it("does not expose profile identity when provider settings are read-only", () => {
    const container = mount(
      props({
        canViewProfiles: false,
        canMutate: false,
        mutationBlockedReason: "Operator admin access required",
        cards: [
          card({
            profiles: [
              {
                profileId: "openai:owner@example.com",
                type: "oauth",
                status: "ok",
                logoutSupported: true,
              },
            ],
            profileProviderIds: { "openai:owner@example.com": "openai" },
            profileOrders: { openai: ["openai:owner@example.com"] },
            profileOrderStoredProviders: ["openai"],
          }),
        ],
      }),
    );

    expect(container.querySelector(".model-providers__profiles")).toBeNull();
    expect(text(container)).not.toContain("owner@example.com");
    expect(text(container.querySelector(".model-providers__credentials"))).toContain(
      "OAuth profiles: 1",
    );
  });

  it("uses the original config key for credential mutations", () => {
    const onSaveKey = vi.fn();
    const onRemoveKey = vi.fn();
    const container = mount(
      props({
        cards: [
          card({
            configKey: "OpenAI",
            apiKey: { source: "config" },
            hasConfigApiKey: true,
          }),
        ],
        keyEditorProvider: "openai",
        keyDraft: "replacement",
        onSaveKey,
        onRemoveKey,
      }),
    );
    const provider = container.querySelector('[data-provider-id="openai"]');
    expect(provider).not.toBeNull();
    button(provider!, "Save")?.click();
    button(provider!, "Remove key")?.click();
    expect(onSaveKey).toHaveBeenCalledWith("openai", "OpenAI");
    expect(onRemoveKey).toHaveBeenCalledWith("openai", "OpenAI");
  });

  it("shows the current key-operation failure over an older card success", () => {
    const container = mount(
      props({
        messages: {
          openai: { kind: "success", text: "Older success" },
          "key:openai": { kind: "error", text: "Current failure" },
        },
      }),
    );
    expect(text(container.querySelector('[data-provider-id="openai"] .callout'))).toBe(
      "Current failure",
    );
  });

  it("disables API-key mutations for explicit non-API-key auth modes", () => {
    const container = mount(
      props({
        cards: [card({ configAuthMode: "oauth" })],
      }),
    );
    const setKey = button(container, "Set API key");
    expect(setKey?.disabled).toBe(true);
    expect(setKey?.title).toContain('auth mode is "oauth"');
  });

  it("hides API-key setup for providers that explicitly do not support it", () => {
    const container = mount(
      props({
        cards: [card({ apiKeySupported: false })],
      }),
    );
    expect(button(container, "Set API key")).toBeUndefined();
  });
});
