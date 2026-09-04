/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import type { ModelProviderCard } from "./data.ts";
import { renderProviderProfiles, type ProviderProfilesViewProps } from "./profiles-view.ts";

function card(overrides: Partial<ModelProviderCard> = {}): ModelProviderCard {
  return {
    id: "openai",
    displayName: "OpenAI",
    profiles: [],
    profileProviderIds: {},
    profileOrders: {},
    profileOrderStoredProviders: [],
    profileOrderLocks: {},
    credentialProviderIds: ["openai"],
    logoutTargets: [],
    hasConfigApiKey: false,
    modelCount: 1,
    availableModelCount: 1,
    ...overrides,
  };
}

function props(overrides: Partial<ProviderProfilesViewProps> = {}): ProviderProfilesViewProps {
  return {
    busy: {},
    canMutate: true,
    mutationBlockedReason: null,
    profileOrders: {},
    onOpenModelSetup: () => undefined,
    onProfileOrderChange: () => undefined,
    onRequestLogout: () => undefined,
    ...overrides,
  };
}

function mount(template: unknown): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  render(template, container);
  return container;
}

describe("renderProviderProfiles", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it("shows account provenance and removes drag controls for config-locked priority", () => {
    const onProfileOrderChange = vi.fn();
    const providerCard = card({
      profiles: [
        {
          profileId: "openai:configured",
          type: "oauth",
          status: "ok",
          source: "config",
          email: "configured@example.com",
        },
        {
          profileId: "openai:codex",
          type: "oauth",
          status: "ok",
          source: "external",
          displayName: "Codex import",
          email: "codex@example.com",
        },
        {
          profileId: "openai:saved",
          type: "oauth",
          status: "ok",
          source: "saved",
          email: "saved@example.com",
        },
        {
          profileId: "openai:inherited",
          type: "oauth",
          status: "ok",
          source: "inherited",
          email: "inherited@example.com",
        },
      ],
      profileProviderIds: {
        "openai:configured": "openai-config",
        "openai:codex": "openai-config",
        "openai:saved": "openai",
        "openai:inherited": "openai",
      },
      profileOrders: {
        "openai-config": ["openai:configured"],
        openai: ["openai:saved", "openai:inherited"],
      },
      profileOrderLocks: { "openai-config": "provider-config" },
    });

    mount(renderProviderProfiles(providerCard, props({ onProfileOrderChange })));

    expect(document.querySelectorAll(".model-providers__profile-grip-spacer")).toHaveLength(2);
    expect(document.querySelectorAll(".model-providers__profile-grip")).toHaveLength(2);
    expect(document.body.textContent).toContain("Provider config");
    expect(document.body.textContent).toContain("Codex import");
    expect(document.body.textContent).toContain("Saved in OpenClaw");
    expect(document.body.textContent).toContain("Shared credential");
    expect(document.body.textContent).toContain("Priority is managed by provider configuration");
    expect(document.body.textContent).toContain("drag to set priority");
    expect(
      [...document.querySelectorAll("button")].map((button) => button.textContent),
    ).not.toContain("Reset");
    expect(onProfileOrderChange).not.toHaveBeenCalled();
  });

  it("points auth-config priority locks to auth.order", () => {
    const container = mount(
      renderProviderProfiles(
        card({
          profiles: [
            { profileId: "openai:one", type: "oauth", status: "ok" },
            { profileId: "openai:two", type: "oauth", status: "ok" },
          ],
          profileProviderIds: {
            "openai:one": "openai",
            "openai:two": "openai",
          },
          profileOrders: { openai: ["openai:one", "openai:two"] },
          profileOrderLocks: { openai: "auth-config" },
        }),
        props(),
      ),
    );

    expect(container.textContent).toContain("Priority is managed by auth.order");
    expect(container.textContent).not.toContain("provider configuration");
    expect(container.querySelectorAll(".model-providers__profile-grip")).toHaveLength(0);
  });

  it("keeps an environment API-key source visible beside account profiles", () => {
    const result = mount(
      renderProviderProfiles(
        card({
          apiKey: { source: "env", envVar: "OPENAI_API_KEY" },
          profiles: [
            {
              profileId: "openai:oauth",
              type: "oauth",
              status: "ok",
              source: "saved",
            },
          ],
          profileOrders: { openai: ["openai:oauth"] },
        }),
        props(),
      ),
    );

    expect(result.textContent).toContain("API key from environment (OPENAI_API_KEY)");
  });

  it("disables reordering when a same-length stored order contains a stale profile", () => {
    const onProfileOrderChange = vi.fn();
    const providerCard = card({
      profiles: [
        { profileId: "openai:one", type: "oauth", status: "ok" },
        { profileId: "openai:two", type: "oauth", status: "ok" },
      ],
      profileProviderIds: {
        "openai:one": "openai",
        "openai:two": "openai",
      },
      profileOrders: { openai: ["openai:removed", "openai:one"] },
      profileOrderStoredProviders: ["openai"],
    });

    const container = mount(renderProviderProfiles(providerCard, props({ onProfileOrderChange })));
    const grips = container.querySelectorAll<HTMLButtonElement>(".model-providers__profile-grip");

    expect([...grips].every((grip) => grip.disabled)).toBe(true);
    expect(grips[0]?.title).toContain("Reset");
    grips[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(onProfileOrderChange).not.toHaveBeenCalled();
  });

  it("identifies managed priority when a shared order spans provider routes", () => {
    const onProfileOrderChange = vi.fn();
    const container = mount(
      renderProviderProfiles(
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
          profileOrders: {
            "shared-owner": ["shared:one", "shared:two", "shared:three"],
          },
        }),
        props({ onProfileOrderChange }),
      ),
    );

    expect(container.querySelectorAll(".model-providers__profile-grip")).toHaveLength(0);
    expect(container.querySelectorAll(".model-providers__profile-grip-spacer")).toHaveLength(2);
    expect(container.textContent).toContain(
      "Priority is inherited or managed across provider routes",
    );
    expect(onProfileOrderChange).not.toHaveBeenCalled();
  });
});
