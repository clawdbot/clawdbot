/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { card, mount, props, text } from "./view.test-support.ts";

describe("model provider card UX", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it("shows native runtime access as ready without claiming provider credentials", () => {
    const container = mount(
      props({
        cards: [
          card({
            apiKey: undefined,
            credentialProviderIds: [],
            modelCount: 4,
            availableModelCount: 4,
            runtimeAvailableModelCount: 4,
            runtimeLabels: ["Claude CLI"],
          }),
        ],
      }),
    );
    const provider = container.querySelector('[data-provider-id="openai"]');

    expect(text(provider)).toContain("Ready");
    expect(text(provider)).toContain("Access through Claude CLI");
    expect(text(provider)).not.toContain("Not configured");
    expect(text(provider)).not.toContain("Not set up");
  });

  it("shows the provider name once with concise model and access facts", () => {
    const container = mount(
      props({
        cards: [
          card({
            id: "xai",
            displayName: "xAI",
            apiKey: undefined,
            credentialProviderIds: ["xai"],
            profiles: [{ profileId: "xai:default", type: "oauth", status: "ok" }],
            modelCount: 2,
            availableModelCount: 2,
          }),
        ],
      }),
    );
    const provider = container.querySelector('[data-provider-id="xai"]');

    expect(provider?.querySelector(".settings-row__title")?.textContent?.trim()).toBe("xAI");
    expect(provider?.querySelector(".settings-row__desc")?.textContent?.trim()).toBe("2 models");
    expect(provider?.querySelector(".model-providers__credentials span")?.textContent?.trim()).toBe(
      "Access",
    );
    expect(
      provider?.querySelector(".model-providers__credentials strong")?.textContent?.trim(),
    ).toBe("1 OAuth account");
  });

  it.each([
    { modelCount: 1, expectedSubtitle: "1 model" },
    { modelCount: 0, expectedSubtitle: null },
  ])("distinguishes $modelCount-model access", ({ modelCount, expectedSubtitle }) => {
    const container = mount(
      props({
        cards: [
          card({
            auth: { kind: "ok", profileCount: 1 },
            catalogStatus: "ready",
            profiles: [{ profileId: "openai:default", type: "oauth", status: "ok" }],
            modelCount,
            availableModelCount: modelCount,
          }),
        ],
        ...(modelCount === 0
          ? {
              configuredModels: [],
              defaultModels: { primary: "", fallbacks: [], utilityModel: null },
            }
          : {}),
      }),
    );
    const provider = container.querySelector('[data-provider-id="openai"]');

    expect(provider?.querySelector(".settings-row__desc")?.textContent?.trim() ?? null).toBe(
      expectedSubtitle,
    );
    if (modelCount === 0) {
      expect(text(container.querySelector('[data-model-readiness="model-required"]'))).toContain(
        "You're signed in, but this account exposes no usable models.",
      );
    }
  });

  it("keeps expired auth more urgent than native runtime readiness", () => {
    const container = mount(
      props({
        cards: [
          card({
            auth: { kind: "expired", profileCount: 1 },
            profiles: [{ profileId: "openai:expired", type: "oauth", status: "expired" }],
            runtimeAvailableModelCount: 1,
            runtimeLabels: ["Claude CLI"],
          }),
        ],
      }),
    );
    const provider = container.querySelector('[data-provider-id="openai"]');

    expect(text(provider)).toContain("Expired");
    expect(text(provider)).not.toContain("Ready");
  });

  it("hides empty usage sections", () => {
    const container = mount(props());
    const provider = container.querySelector('[data-provider-id="openai"]');

    expect(provider?.querySelector(".model-providers__global-metrics")).toBeNull();
    expect(text(provider)).not.toContain("No live usage data reported");
  });

  it("reports unknown local cost instead of a false zero", () => {
    const container = mount(
      props({
        cards: [
          card({
            localCost: {
              totalCost: 0,
              totalTokens: 2_100_000,
              sessionCount: 28,
              missingCostEntries: 28,
            },
          }),
        ],
      }),
    );
    const provider = container.querySelector('[data-provider-id="openai"]');

    expect(text(provider)).toContain("Cost unavailable");
    expect(text(provider)).not.toContain("$0.00");
    expect(text(provider)).toContain("2.1M tokens · 28 sessions");
  });
});
