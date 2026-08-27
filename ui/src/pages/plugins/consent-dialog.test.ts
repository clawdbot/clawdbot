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

  it.each([
    {
      source: {
        kind: "clawhub",
        packageName: "@openclaw/calendar-plus",
        integrity: "sha256-0123456789abcdefghijklmnop",
        integrityKind: "ssri",
      },
      provenance: "ClawHub · @openclaw/calendar-plus",
      integrityLabel: "Integrity: sha256-0123456789abc…",
    },
    {
      source: {
        kind: "git",
        spec: "https://***:***@example.com/calendar.git?token=***#main",
        integrity: "0123456789abcdef0123456789abcdef01234567",
        integrityKind: "git-commit",
      },
      provenance: "Git · https://***:***@example.com/calendar.git?token=***#main",
      integrityLabel: "Commit: 0123456789abcdef0123…",
    },
  ] as const)(
    "presents capabilities, grants, safe $source.kind provenance, and trust before install",
    ({ source, provenance, integrityLabel }) => {
      const inspection = createInspectResult({
        plugin: {
          id: "calendar-runtime",
          name: "Calendar Plus",
          version: "2.0.0",
          origin: "global",
          installed: false,
          enabled: false,
        },
        source,
        declared: {
          channels: ["calendar-channel"],
          providers: ["calendar-provider"],
          tools: ["calendar_create"],
          contracts: ["gatewayMethodDispatch: calendar.dispatch"],
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
        provenance,
        integrityLabel,
        "Review required",
        "Requests an elevated permission",
        "Scanned 2026-08-25",
        "calendar-channel",
        "calendar-provider",
        "calendar_create",
        "Contracts gatewayMethodDispatch: calendar.dispatch",
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
      expect(dialog?.querySelector("[title]")?.getAttribute("title")).toBe(source.integrity);
      dialog?.querySelector<HTMLButtonElement>(".btn.primary")?.click();
      expect(onConfirm).toHaveBeenCalledOnce();
    },
  );

  it("explains an empty manifest and preserves external-plugin grants", () => {
    const container = mount();
    const text = normalizedText(container.querySelector('[data-plugin-consent="enable"]'));

    expect(text).toContain("No channels, providers, or tools declared in the manifest.");
    expect(text).toContain(
      "Code plugins may register hooks at runtime; their hook names are not declared in the manifest.",
    );
    expect(text).toContain("Your grants");
    expect(text).toContain("Enable Workboard");
    expect(text).not.toContain("What changed");
  });

  it("highlights newly declared capability groups since the previous acceptance", () => {
    const inspection = createInspectResult({
      declared: {
        ...createInspectResult().declared,
        tools: ["workboard_review"],
        contracts: ["gatewayMethodDispatch: workboard.dispatch"],
        providers: ["workboard-provider"],
        dangerousConfigFlags: ["workboard.allowShell"],
      },
    });
    const container = mount({
      consent: {
        intent: { kind: "enable", pluginId: "workboard", rowKey: "plugin:workboard" },
        pluginId: "workboard",
        fallback: { name: "Workboard" },
        details: buildCapabilityConsentErrorDetails({
          pluginId: "workboard",
          reviewToken: inspection.reviewToken,
          widened: {
            tools: ["workboard_review"],
            contracts: ["gatewayMethodDispatch: workboard.dispatch"],
            providers: ["workboard-provider"],
            dangerousConfigFlags: ["workboard.allowShell"],
          },
          acceptedAt: "2026-08-20T14:03:00Z",
        }),
      },
      inspection,
    });

    const dialog = container.querySelector('[data-plugin-consent="enable"]');
    const text = normalizedText(dialog);
    expect(text).toContain("What changed");
    expect(text).toContain("New since your last acceptance");
    expect(text).toContain("2026-08-20T14:03:00Z");
    expect(text).toContain("Tools workboard_review");
    expect(text).toContain("Contracts gatewayMethodDispatch: workboard.dispatch");
    expect(text).toContain("Model providers workboard-provider");
    expect(text).toContain("Dangerous config flags workboard.allowShell");
    expect(text.indexOf("What changed")).toBeLessThan(text.indexOf("Declared capabilities"));
    expect(dialog?.querySelectorAll(".plugins-consent__row--warning")).toHaveLength(5);
  });

  it("prevents approval until the package capabilities have been inspected", () => {
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
        },
      },
      inspection: null,
    });

    const dialog = container.querySelector('[data-plugin-consent="install"]');
    expect(normalizedText(dialog)).toContain("Community Calendar");
    expect(normalizedText(dialog)).toContain(
      "Capability details must be available before you can approve this plugin.",
    );
    expect(dialog?.querySelector<HTMLButtonElement>(".btn.primary")?.disabled).toBe(true);
  });

  it("prevents consent confirmation when the operator cannot mutate plugins", () => {
    const container = mount({ canMutate: false, mutationBlockedReason: "Admin access required." });
    const confirm = container.querySelector<HTMLButtonElement>(".btn.primary");

    expect(confirm?.disabled).toBe(true);
    expect(confirm?.title).toBe("Admin access required.");
  });
});
