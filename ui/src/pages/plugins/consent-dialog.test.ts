/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCapabilityConsentErrorDetails } from "../../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import { i18n } from "../../i18n/index.ts";
import { renderPluginConsentDialog } from "./consent-dialog.ts";
import { createInspectResult } from "./plugins-page.test-support.ts";

type ConsentProps = Parameters<typeof renderPluginConsentDialog>[0];

function mount(overrides: Partial<ConsentProps> = {}): HTMLDivElement {
  const props: ConsentProps = {
    consent: {
      intent: { kind: "enable", pluginId: "workboard", rowKey: "plugin:workboard" },
      pluginId: "workboard",
      fallback: { name: "Workboard" },
    },
    inspection: createInspectResult(),
    loading: false,
    error: null,
    canMutate: true,
    mutationBlockedReason: null,
    busy: false,
    onCancel: () => undefined,
    onConfirm: () => undefined,
    onRetry: () => undefined,
    ...overrides,
  };
  const container = document.createElement("div");
  document.body.append(container);
  render(renderPluginConsentDialog(props), container);
  return container;
}

function normalizedText(element: Element | null): string {
  return element?.textContent?.replace(/\s+/gu, " ").trim() ?? "";
}

describe("renderPluginConsentDialog", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    for (const container of document.body.querySelectorAll("div")) {
      render(nothing, container);
    }
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("presents manifest capabilities, effective grants, provenance, and the trust verdict before install", () => {
    const inspection = createInspectResult({
      plugin: {
        id: "calendar-runtime",
        name: "Calendar Plus",
        version: "2.0.0",
        origin: "global",
        installed: false,
        enabled: false,
      },
      source: {
        kind: "clawhub",
        packageName: "@openclaw/calendar-plus",
        integrity: "sha256-0123456789abcdefghijklmnop",
        integrityKind: "ssri",
      },
      declared: {
        channels: ["calendar-channel"],
        providers: ["calendar-provider"],
        tools: ["calendar_create"],
        hooks: ["before_prompt_build"],
        mcpServers: ["calendar-mcp"],
        cliCommands: ["calendar"],
        cliBackends: ["calendar-cli"],
        skills: ["schedule"],
        dangerousConfigFlags: ["calendar.allowShell"],
      },
      grants: {
        hooks: {
          allowPromptInjection: { effective: false, configured: false },
          allowConversationAccess: { effective: false },
        },
        llm: { allowedModels: ["model-a", "model-b"] },
        subagent: { allowModelOverride: true },
      },
      trust: {
        disposition: "review-required",
        reasons: ["Requests an elevated permission"],
        checkedAt: "2026-08-25",
      },
    });
    const onConfirm = vi.fn();
    const container = mount({
      consent: {
        intent: {
          kind: "install",
          request: { source: "clawhub", packageName: "@openclaw/calendar-plus" },
          installIdentity: "plugin:calendar-runtime",
        },
        pluginId: "calendar-runtime",
        fallback: { name: "Calendar Plus", version: "2.0.0" },
      },
      inspection,
      onConfirm,
    });

    const dialog = container.querySelector('[data-plugin-consent="install"]');
    const text = normalizedText(dialog);
    for (const value of [
      "Calendar Plus",
      "v2.0.0",
      "@openclaw/calendar-plus",
      "Integrity: sha256-0123456789abc…",
      "Review required",
      "Requests an elevated permission",
      "Scanned 2026-08-25",
      "calendar-channel",
      "calendar-provider",
      "calendar_create",
      "before_prompt_build",
      "calendar-mcp",
      "calendar-cli",
      "schedule",
      "Dangerous config flags calendar.allowShell",
      "Prompt injection Blocked (set in config)",
      "Conversation access Off (default)",
      "Off by default for external plugins.",
      "Allowed models: model-a, model-b",
      "Subagent model overrides Model override: Allowed",
      "Install Calendar Plus",
    ]) {
      expect(text).toContain(value);
    }
    expect(dialog?.querySelector("[title]")?.getAttribute("title")).toBe(
      "sha256-0123456789abcdefghijklmnop",
    );
    dialog?.querySelector<HTMLButtonElement>(".btn.primary")?.click();
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("explains an empty manifest and preserves external-plugin grants", () => {
    const container = mount();
    const text = normalizedText(container.querySelector('[data-plugin-consent="enable"]'));

    expect(text).toContain("No channels, providers, or tools declared in the manifest.");
    expect(text).toContain("Your grants");
    expect(text).toContain("Enable Workboard");
    expect(text).not.toContain("What changed");
  });

  it("highlights newly declared capability groups since the previous acceptance", () => {
    const inspection = createInspectResult();
    const container = mount({
      consent: {
        intent: { kind: "enable", pluginId: "workboard", rowKey: "plugin:workboard" },
        pluginId: "workboard",
        fallback: { name: "Workboard" },
        details: buildCapabilityConsentErrorDetails({
          pluginId: "workboard",
          name: "Workboard",
          declared: {
            ...inspection.declared,
            tools: ["workboard_review"],
            providers: ["workboard-provider"],
            dangerousConfigFlags: ["workboard.allowShell"],
          },
          grants: inspection.grants,
          widened: {
            tools: ["workboard_review"],
            providers: ["workboard-provider"],
            dangerousConfigFlags: ["workboard.allowShell"],
          },
          acceptedAt: "2026-08-20T14:03:00Z",
        }),
      },
      inspection: null,
    });

    const dialog = container.querySelector('[data-plugin-consent="enable"]');
    const text = normalizedText(dialog);
    expect(text).toContain("What changed");
    expect(text).toContain("New since your last acceptance");
    expect(text).toContain("2026-08-20T14:03:00Z");
    expect(text).toContain("Tools workboard_review");
    expect(text).toContain("Model providers workboard-provider");
    expect(text).toContain("Dangerous config flags workboard.allowShell");
    expect(text.indexOf("What changed")).toBeLessThan(text.indexOf("Declared capabilities"));
    expect(dialog?.querySelectorAll(".plugins-consent__row--warning")).toHaveLength(4);
  });

  it("explains integrity and review protection when a package cannot be inspected yet", () => {
    const container = mount({
      consent: {
        intent: {
          kind: "install",
          request: { source: "clawhub", packageName: "community-calendar" },
          installIdentity: "clawhub:community-calendar",
        },
        pluginId: null,
        fallback: {
          name: "Community Calendar",
          version: "1.2.0",
          official: false,
          verificationTier: "source-linked",
        },
      },
      inspection: null,
    });

    const dialog = container.querySelector('[data-plugin-consent="install"]');
    expect(normalizedText(dialog)).toContain("Community Calendar");
    expect(normalizedText(dialog)).toContain("Verified source");
    expect(normalizedText(dialog)).toContain(
      "Capability declarations are verified during install. The download is integrity-pinned, and risky findings pause the install for review.",
    );
    expect(dialog?.querySelector<HTMLButtonElement>(".btn.primary")?.disabled).toBe(false);
  });

  it("prevents consent confirmation when the operator cannot mutate plugins", () => {
    const container = mount({ canMutate: false, mutationBlockedReason: "Admin access required." });
    const confirm = container.querySelector<HTMLButtonElement>(".btn.primary");

    expect(confirm?.disabled).toBe(true);
    expect(confirm?.title).toBe("Admin access required.");
  });
});
