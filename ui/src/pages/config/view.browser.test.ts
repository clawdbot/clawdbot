// Control UI tests cover config behavior.
import { render } from "lit";
import { beforeAll, describe, expect, it, vi } from "vitest";
import "../../styles.css";
import type { ThemeMode, ThemeName } from "../../app/theme.ts";
import { renderConfigForm } from "../../components/config-form.ts";
import { warmJson5 } from "../../lib/json5-runtime.ts";
import { renderBrowserLinkPreferencesRow } from "./browser-link-preferences.ts";
import { createConfigViewState, renderConfig, type ConfigProps } from "./view.ts";

describe("config view", () => {
  // The view module warms the lazy JSON5 parser on load; tests assert the
  // steady state where raw diffs parse synchronously.
  beforeAll(async () => {
    await warmJson5();
  });

  const baseProps = () => ({
    raw: "{\n}\n",
    originalRaw: "{\n}\n",
    valid: true,
    issues: [],
    loading: false,
    saving: false,
    applying: false,
    updating: false,
    connected: true,
    schema: {
      type: "object",
      properties: {},
    },
    schemaLoading: false,
    uiHints: {},
    formMode: "form" as const,
    viewState: createConfigViewState(),
    showModeToggle: true,
    formValue: {},
    originalValue: {},
    activeSection: null,
    activeSubsection: null,
    onRawChange: vi.fn(),
    onFormModeChange: vi.fn(),
    onViewStateChange: vi.fn(),
    onFormPatch: vi.fn(),
    onFormRemove: vi.fn(),
    onSectionChange: vi.fn(),
    onSave: vi.fn(),
    onRawDiscard: vi.fn(),
    onSubsectionChange: vi.fn(),
    version: "2026.3.11",
    theme: "claw" as ThemeName,
    themeOverridden: false,
    themeProvenance: "default" as const,
    themeResetValue: "claw" as ThemeName,
    themeMode: "system" as ThemeMode,
    themeModeOverridden: false,
    themeModeProvenance: "default" as const,
    themeModeResetValue: "system" as ThemeMode,
    systemLocale: "en" as const,
    localeOverride: undefined,
    localeOverridden: false,
    localeProvenance: "default" as const,
    localeResetValue: undefined,
    onLocaleChange: vi.fn(),
    resetLocale: vi.fn(),
    setTheme: vi.fn(),
    resetTheme: vi.fn(),
    setThemeMode: vi.fn(),
    resetThemeMode: vi.fn(),
    hasCustomTheme: false,
    customThemeLabel: null,
    customThemeSourceUrl: null,
    customThemeImportUrl: "",
    customThemeImportBusy: false,
    customThemeImportMessage: null,
    customThemeImportExpanded: false,
    customThemeImportFocusToken: 0,
    onCustomThemeImportUrlChange: vi.fn(),
    onImportCustomTheme: vi.fn(),
    onClearCustomTheme: vi.fn(),
    onOpenCustomThemeImport: vi.fn(),
    textScale: 100,
    textScaleOverridden: false,
    setTextScale: vi.fn(),
    resetTextScale: vi.fn(),
    sidebarLiveActivity: true,
    setSidebarLiveActivity: vi.fn(),
    hiddenSessionCatalogIds: new Set<string>(),
    hiddenSessionCatalogLabels: new Map<string, string>(),
    setSessionCatalogHidden: vi.fn(),
    chatMessageMaxWidth: undefined,
    setChatMessageMaxWidth: vi.fn(),
    showAdvancedSettings: false,
    setShowAdvancedSettings: vi.fn(),
    chatSendShortcut: "enter" as const,
    chatSendShortcutOverridden: false,
    chatSendShortcutProvenance: "default" as const,
    chatSendShortcutResetValue: "enter" as const,
    setChatSendShortcut: vi.fn(),
    resetChatSendShortcut: vi.fn(),
    chatFollowUpMode: undefined,
    chatFollowUpModeOverridden: false,
    chatFollowUpModeProvenance: "default" as const,
    serverQueueMode: "steer" as const,
    setChatFollowUpMode: vi.fn(),
    resetChatFollowUpMode: vi.fn(),
    catalogOpenTarget: "viewer" as const,
    setCatalogOpenTarget: vi.fn(),
    gatewayUrl: "",
    assistantName: "OpenClaw",
  });

  it("lets config pages grow with their content instead of creating an inner viewport", async () => {
    const { container } = renderConfigView({
      activeSection: "__appearance__",
      includeSections: ["__appearance__"],
      customThemeImportExpanded: true,
    });
    document.body.append(container);

    try {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });

      const content = queryRequired(container, ".config-content", HTMLElement);
      expect(content.scrollHeight - content.clientHeight).toBeLessThanOrEqual(1);
    } finally {
      container.remove();
    }
  });

  it("renders System language first on Appearance and emits locale overrides", () => {
    const onLocaleChange = vi.fn();
    const { container } = renderConfigView({
      activeSection: "__appearance__",
      includeSections: ["__appearance__"],
      systemLocale: "pt-BR",
      localeOverride: undefined,
      onLocaleChange,
    });

    const sections = [...container.querySelectorAll<HTMLElement>(".settings-section")];
    expect(sections[0]?.id).toBe("settings-language");
    expect(sections[0]?.textContent).toContain("Language");
    expect(sections[0]?.textContent).toContain("Synced across your devices through the gateway");

    const select = sections[0]?.querySelector("wa-select") as
      | (HTMLElement & { value: string })
      | null;
    expect(select?.value).toBe("system");
    expect(sections[0]?.querySelector('wa-option[value="system"]')?.textContent).toContain(
      "System (Português (Brazilian Portuguese))",
    );
    if (select) {
      Object.defineProperty(select, "value", { configurable: true, value: "fr" });
      select.dispatchEvent(new Event("change", { bubbles: true }));
      Object.defineProperty(select, "value", { configurable: true, value: "system" });
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    expect(onLocaleChange).toHaveBeenCalledWith("fr");
    expect(onLocaleChange).toHaveBeenCalledWith(undefined);
  });

  it("labels System from the navigator locale while an explicit locale is selected", () => {
    const { container } = renderConfigView({
      activeSection: "__appearance__",
      includeSections: ["__appearance__"],
      systemLocale: "de",
      localeOverride: "fr",
      localeOverridden: true,
    });
    const select = queryRequired(
      container,
      "#settings-language wa-select",
      HTMLElement,
    ) as HTMLElement & { value: string };

    expect(
      (
        select.querySelector('wa-option[value="fr"]') as
          | (HTMLElement & { selected: boolean })
          | null
      )?.selected,
    ).toBe(true);
    expect(select.querySelector('wa-option[value="system"]')?.textContent).toContain(
      "System (Deutsch (German))",
    );
  });

  function findOptionalButtonByText(
    container: HTMLElement,
    text: string,
  ): HTMLButtonElement | undefined {
    return Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === text,
    );
  }

  function renderConfigView(overrides: Partial<ConfigProps> = {}): {
    container: HTMLElement;
    props: ConfigProps;
  } {
    const container = document.createElement("div");
    const props = {
      ...baseProps(),
      ...overrides,
    };
    const rerender = () =>
      render(
        renderConfig({
          ...props,
          onViewStateChange: rerender,
        }),
        container,
      );
    rerender();
    return { container, props };
  }

  function normalizedText(container: HTMLElement): string {
    return container.textContent?.replace(/\s+/g, " ").trim() ?? "";
  }

  it("places a Control UI Browser preference in the same settings group before schema rows", () => {
    const { container } = renderConfigView({
      schema: {
        type: "object",
        properties: {
          browser: {
            type: "object",
            title: "Browser",
            properties: {
              enabled: { type: "boolean", title: "Browser Enabled" },
            },
          },
        },
      },
      uiHints: { "browser.enabled": { advanced: false } },
      formValue: { browser: { enabled: true } },
      activeSection: "browser",
      sectionPrelude: renderBrowserLinkPreferencesRow({
        enabled: false,
        onChange: vi.fn(),
      }),
    });

    const groups = container.querySelectorAll("#config-section-browser .settings-group");
    expect(groups).toHaveLength(1);
    expect(
      [...groups[0]!.querySelectorAll(".settings-row__title")].map((node) =>
        node.textContent?.trim(),
      ),
    ).toEqual(["Open links in Control UI browser", "Browser Enabled"]);
  });

  it("routes restore-default actions through config removal", () => {
    const onFormPatch = vi.fn();
    const onFormRemove = vi.fn();
    const { container } = renderConfigView({
      schema: {
        type: "object",
        properties: {
          gateway: {
            type: "object",
            title: "Gateway",
            properties: {
              retries: { type: "integer", title: "Retries", default: 3 },
              mode: {
                type: "string",
                title: "Mode",
                default: "balanced",
                enum: ["balanced", "fast", "careful", "safe", "strict", "custom"],
              },
            },
          },
        },
      },
      uiHints: {
        "gateway.retries": { advanced: false },
        "gateway.mode": { advanced: false },
      },
      formValue: { gateway: { retries: 9, mode: "custom" } },
      activeSection: "gateway",
      onFormPatch,
      onFormRemove,
    });

    const retriesRow = Array.from(container.querySelectorAll<HTMLElement>(".settings-row")).find(
      (row) => row.textContent?.includes("Retries"),
    );
    queryRequired(
      retriesRow ?? container,
      "button[aria-label='Reset to default']",
      HTMLButtonElement,
    ).click();
    expect(onFormRemove).toHaveBeenCalledWith(["gateway", "retries"]);
    expect(onFormPatch).not.toHaveBeenCalled();

    const modeRow = Array.from(container.querySelectorAll<HTMLElement>(".settings-row")).find(
      (row) => row.textContent?.includes("Mode"),
    );
    const select = queryRequired(modeRow ?? container, "select", HTMLSelectElement);
    expect(select.selectedOptions[0]?.textContent?.trim()).toBe("custom");
    select.value = "__unset__";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onFormRemove).toHaveBeenCalledWith(["gateway", "mode"]);
  });

  it("uses one inline advanced disclosure without mutating config fields", () => {
    const schema = {
      type: "object",
      properties: {
        gateway: {
          type: "object",
          properties: {
            port: { type: "integer", title: "Port" },
            reload: { type: "string", title: "Reload mode" },
          },
        },
      },
    };
    const uiHints = {
      "gateway.port": { advanced: false },
      "gateway.reload": { advanced: true },
    };
    const setShowAdvancedSettings = vi.fn();
    const collapsed = renderConfigView({
      schema,
      uiHints,
      formValue: { gateway: { port: 18789, reload: "hybrid" } },
      activeSection: "gateway",
      setShowAdvancedSettings,
    });

    const ghost = queryRequired(collapsed.container, ".config-advanced-ghost", HTMLButtonElement);
    expect(ghost.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "1 advanced setting hidden Show advanced",
    );
    ghost.click();
    expect(setShowAdvancedSettings).toHaveBeenCalledWith(true);
    expect(ghost.classList.contains("config-show-advanced")).toBe(true);
    expect(ghost.getAttribute("aria-pressed")).toBe("false");

    const global = renderConfigView({
      schema,
      uiHints,
      formValue: { gateway: { port: 18789, reload: "hybrid" } },
      activeSection: "gateway",
      showAdvancedSettings: true,
    });
    expect(global.container.querySelector(".config-advanced-ghost")).toBeNull();
    const divider = queryRequired(global.container, ".config-advanced-divider", HTMLElement);
    expect(divider.textContent?.replace(/\s+/g, " ").trim()).toBe("Advanced Hide Advanced");
    const hide = queryRequired(divider, ".config-advanced-divider__toggle", HTMLButtonElement);
    expect(hide.classList.contains("config-show-advanced")).toBe(true);
    expect(hide.getAttribute("aria-pressed")).toBe("true");
    hide.click();
    expect(global.props.setShowAdvancedSettings).toHaveBeenCalledWith(false);
    expect(normalizedText(global.container)).toContain("Reload mode");

    const searchHit = renderConfigView({
      schema,
      uiHints,
      formValue: { gateway: { port: 18789, reload: "hybrid" } },
      activeSection: "gateway",
      forceAdvancedSection: "gateway",
    });
    expect(searchHit.container.querySelector(".config-advanced-ghost")).toBeNull();
    expect(normalizedText(searchHit.container)).toContain("Reload mode");

    const nested = document.createElement("div");
    render(
      renderConfigForm({
        schema: {
          type: "object",
          properties: {
            agents: {
              type: "object",
              properties: {
                defaults: {
                  type: "object",
                  properties: { tuning: { type: "boolean" } },
                },
              },
            },
          },
        },
        uiHints: { "agents.defaults.tuning": { advanced: true } },
        value: { agents: { defaults: { tuning: true } } },
        activeSection: "agents",
        activeSubsection: "defaults",
        forceAdvancedSection: "agents",
        onShowAdvanced: vi.fn(),
        onPatch: vi.fn(),
      }),
      nested,
    );
    expect(nested.querySelector(".config-advanced-ghost")).toBeNull();
    expect(normalizedText(nested)).toContain("Tuning");

    const forcedPage = renderConfigView({
      schema,
      uiHints,
      formValue: { gateway: { port: 18789, reload: "hybrid" } },
      activeSection: "gateway",
      forceShowAdvanced: true,
    });
    expect(findOptionalButtonByText(forcedPage.container, "Show advanced")).toBeUndefined();
    expect(forcedPage.container.querySelector(".config-advanced-ghost")).toBeNull();
    expect(normalizedText(forcedPage.container)).toContain("Reload mode");
  });

  it("offers the toggle exactly when the active scope can hide advanced fields", () => {
    const schema = {
      type: "object",
      properties: {
        gateway: {
          type: "object",
          properties: { mode: { type: "string", title: "Mode" } },
        },
        diagnostics: {
          type: "object",
          properties: { flags: { type: "string", title: "Flags" } },
        },
      },
    };

    // Unhinted leaves default to the advanced tier, so the inline disclosure
    // must remain available even when no hint carries advanced === true.
    const unhinted = renderConfigView({
      schema,
      uiHints: {},
      formValue: { diagnostics: { flags: "all" } },
      activeSection: "diagnostics",
    });
    expect(findOptionalButtonByText(unhinted.container, "Show advanced")).toBeUndefined();
    expect(unhinted.container.querySelector(".config-advanced-ghost")).not.toBeNull();

    // An advanced hint in a different top-level section must not surface a
    // no-op toggle on a fully-common active section.
    const offScope = renderConfigView({
      schema,
      uiHints: {
        "gateway.mode": { advanced: false },
        "diagnostics.flags": { advanced: true },
      },
      formValue: { gateway: { mode: "local" } },
      activeSection: "gateway",
    });
    expect(findOptionalButtonByText(offScope.container, "Show advanced")).toBeUndefined();
    expect(offScope.container.querySelector(".config-advanced-ghost")).toBeNull();
  });

  it("shows the form-unsafe banner only for populated unsupported paths", () => {
    const schema = {
      type: "object",
      properties: {
        gateway: {
          type: "object",
          properties: {
            opaque: {
              title: "Opaque setting",
              anyOf: [{ type: "string" }, {}],
            },
          },
        },
        agents: {
          type: "object",
          properties: {
            opaque: { anyOf: [{ type: "string" }, {}] },
          },
        },
      },
    };

    const empty = renderConfigView({
      schema,
      formValue: { gateway: {}, agents: { opaque: "off-scope" } },
      activeSection: "gateway",
    });
    expect(empty.container.querySelector(".config-content-callout .info")).toBeNull();
    expect(findButtonByText(empty.container, "Form").getAttribute("title")).toBe("");

    const onFormModeChange = vi.fn();
    const populated = renderConfigView({
      schema,
      formValue: {
        gateway: { opaque: "custom" },
        agents: { opaque: "off-scope" },
      },
      activeSection: "gateway",
      onFormModeChange,
    });
    const banner = queryRequired(
      populated.container,
      ".config-content-callout .callout.info",
      HTMLElement,
    );
    expect(normalizedText(banner)).toBe(
      "1 setting in this config can only be edited as text: gateway.opaque Open Raw editor",
    );
    expect(banner.querySelector("code")?.textContent).toBe("gateway.opaque");
    expect(findButtonByText(populated.container, "Form").getAttribute("title")).toBe(
      "Form view can't safely edit some fields",
    );
    findButtonByText(banner, "Open Raw editor").click();
    expect(onFormModeChange).toHaveBeenCalledWith("raw");
  });

  function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === text,
    );
    if (!button) {
      throw new Error(`Expected button with text "${text}"`);
    }
    return button;
  }

  function findButtonContainingText(container: HTMLElement, text: string): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes(text),
    );
    if (!button) {
      throw new Error(`Expected button containing text "${text}"`);
    }
    return button;
  }

  function sectionTabLabels(container: HTMLElement): Array<string | undefined> {
    return Array.from(container.querySelectorAll(".config-toolbar wa-radio")).map((tab) =>
      tab.textContent?.trim(),
    );
  }

  function selectConfigTab(container: HTMLElement, name: string) {
    const group = queryRequired(
      container,
      ".config-toolbar wa-radio-group",
      HTMLElement,
    ) as HTMLElement & { value: string };
    group.value = name;
    group.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function queryRequired<T extends Element>(
    container: HTMLElement,
    selector: string,
    constructor: new () => T,
  ): T {
    const element = container.querySelector(selector);
    expect(element).toBeInstanceOf(constructor);
    if (!(element instanceof constructor)) {
      throw new Error(`Expected element matching "${selector}"`);
    }
    return element;
  }

  it("drops the legacy actions toolbar and keeps form mode button-free", () => {
    const { container } = renderConfigView({
      schema: {
        type: "object",
        properties: {
          gateway: { type: "object", properties: { mode: { type: "string" } } },
        },
      },
      uiHints: { "gateway.mode": { advanced: false } },
      formValue: { gateway: { mode: "remote" } },
      originalValue: { gateway: { mode: "local" } },
    });

    expect(container.querySelector(".config-actions")).toBeNull();
    expect(container.querySelector(".config-layout")).toBeNull();
    expect(container.querySelector(".config-search__input")).toBeNull();
    for (const label of ["Reload", "Clear", "Save", "Apply", "Update"]) {
      expect(findOptionalButtonByText(container, label)).toBeUndefined();
    }
  });

  it("keeps explicit open/save/discard controls in raw mode", () => {
    const onSave = vi.fn();
    const onRawDiscard = vi.fn();
    const onOpenFile = vi.fn();
    const { container } = renderConfigView({
      formMode: "raw",
      raw: '{\n  gateway: { mode: "remote" }\n}\n',
      originalRaw: '{\n  gateway: { mode: "local" }\n}\n',
      onSave,
      onRawDiscard,
      onOpenFile,
    });

    const actions = queryRequired(container, ".config-raw-actions", HTMLElement);
    expect(
      [...actions.querySelectorAll("button")].map((button) => button.textContent?.trim()),
    ).toEqual(["Open", "Discard", "Save"]);
    findButtonContainingText(actions, "Open").click();
    findButtonByText(actions, "Discard").click();
    findButtonByText(actions, "Save").click();
    expect(onOpenFile).toHaveBeenCalledTimes(1);
    expect(onRawDiscard).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("pins the raw editor while an unsaved raw draft is authoritative", () => {
    const { container } = renderConfigView({
      formMode: "form",
      rawDraftPending: true,
      raw: '{\n  "a": 1\n}\n',
      originalRaw: "{\n}\n",
    });

    // The capability refuses form submissions until the raw draft is saved or
    // discarded, so the raw actions stay on screen and Form remains gated.
    expect(container.querySelector(".config-raw-actions")).not.toBeNull();
    expect(findButtonByText(container, "Form").disabled).toBe(true);
  });

  it("disables raw save/discard without changes and locks the editor while busy", () => {
    const clean = renderConfigView({
      formMode: "raw",
      raw: "{\n}\n",
      originalRaw: "{\n}\n",
    });
    expect(findButtonByText(clean.container, "Save").disabled).toBe(true);
    expect(findButtonByText(clean.container, "Discard").disabled).toBe(true);

    const saving = renderConfigView({
      formMode: "raw",
      raw: '{\n  gateway: { mode: "remote" }\n}\n',
      originalRaw: '{\n  gateway: { mode: "local" }\n}\n',
      saving: true,
    });
    const busyButton = findButtonContainingText(saving.container, "Saving…");
    expect(busyButton.disabled).toBe(true);
    expect(busyButton.getAttribute("aria-busy")).toBe("true");
    expect(busyButton.querySelectorAll(".config-action-spinner")).toHaveLength(1);
    const rawEditor = saving.container.querySelector(".config-raw-field textarea");
    expect(rawEditor).toBeInstanceOf(HTMLTextAreaElement);
    expect(rawEditor?.hasAttribute("disabled")).toBe(true);
  });

  it("locks form inputs while a config operation is pending", () => {
    const { container } = renderConfigView({
      applying: true,
      schema: {
        type: "object",
        properties: {
          gateway: { type: "object", properties: { mode: { type: "string" } } },
        },
      },
      uiHints: { "gateway.mode": { advanced: false } },
      formValue: { gateway: { mode: "remote" } },
      originalValue: { gateway: { mode: "local" } },
    });
    expect(container.querySelector(".config-content input")?.hasAttribute("disabled")).toBe(true);
  });

  it("switches mode via the sidebar toggle", () => {
    const container = document.createElement("div");
    const onFormModeChange = vi.fn();
    render(
      renderConfig({
        ...baseProps(),
        onFormModeChange,
      }),
      container,
    );

    const btn = findButtonByText(container, "Raw");
    btn.click();
    expect(onFormModeChange).toHaveBeenCalledWith("raw");
  });

  it("shows the form safety warning only in form mode", () => {
    const container = document.createElement("div");
    const props = {
      ...baseProps(),
      schema: {
        type: "object",
        properties: {
          lastTouchedAt: {
            anyOf: [{ type: "string" }, {}],
          },
        },
      },
      formValue: { lastTouchedAt: "2026-07-13T00:00:00.000Z" },
      originalValue: { lastTouchedAt: "2026-07-13T00:00:00.000Z" },
    };

    render(renderConfig({ ...props, formMode: "form" }), container);
    expect(normalizedText(container)).toContain(
      "1 setting in this config can only be edited as text: lastTouchedAt Open Raw editor",
    );

    render(renderConfig({ ...props, formMode: "raw" }), container);
    expect(normalizedText(container)).not.toContain(
      "1 setting in this config can only be edited as text: lastTouchedAt Open Raw editor",
    );
    expect(container.querySelector(".config-raw-field")).not.toBeNull();
  });

  it("forces Form mode and disables Raw mode when raw text is unavailable", () => {
    const onFormModeChange = vi.fn();
    const { container } = renderConfigView({
      formMode: "raw",
      rawAvailable: false,
      onFormModeChange,
      schema: {
        type: "object",
        properties: {
          gateway: {
            type: "object",
            properties: {
              mode: { type: "string" },
            },
          },
        },
      },
      formValue: { gateway: { mode: "local" } },
      originalValue: { gateway: { mode: "local" } },
    });

    const formButton = findButtonByText(container, "Form");
    const rawButton = findButtonByText(container, "Raw");
    expect([...formButton.classList]).toEqual(["config-mode-toggle__btn", "active"]);
    expect(rawButton.disabled).toBe(true);
    expect(rawButton.getAttribute("title")).toBe("Raw mode unavailable for this snapshot");
    expect(container.querySelector(".config-raw-field")).toBeNull();

    rawButton.click();
    expect(onFormModeChange).not.toHaveBeenCalled();
  });

  it("renders section tabs and switches sections from the sidebar", () => {
    const container = document.createElement("div");
    const onSectionChange = vi.fn();
    render(
      renderConfig({
        ...baseProps(),
        onSectionChange,
        schema: {
          type: "object",
          properties: {
            gateway: { type: "object", properties: {} },
            agents: { type: "object", properties: {} },
          },
        },
      }),
      container,
    );

    expect(sectionTabLabels(container)).toEqual(["Settings", "Agents", "Gateway", "Theme"]);
    // Segmented pills replaced the old tab strip and the inner panel chrome.
    expect(container.querySelector("wa-tab-group")).toBeNull();
    expect(container.querySelector(".config-layout")).toBeNull();

    selectConfigTab(container, "gateway");
    expect(onSectionChange).toHaveBeenCalledWith("gateway");

    onSectionChange.mockClear();
    const active = container.querySelector(".config-toolbar .settings-segmented__btn--active");
    expect(active?.textContent?.trim()).toBe("Settings");
    selectConfigTab(container, "agents");
    expect(onSectionChange).toHaveBeenCalledWith("agents");

    onSectionChange.mockClear();
    selectConfigTab(container, "root");
    expect(onSectionChange).toHaveBeenCalledWith(null);
  });

  it("renders the virtual Notifications tab on Notifications settings", () => {
    const onSectionChange = vi.fn();
    const { container } = renderConfigView({
      navRootLabel: "Notifications",
      includeSections: ["__notifications__"],
      includeVirtualSections: true,
      onSectionChange,
      schema: {
        type: "object",
        properties: {},
      },
      formValue: {},
      originalValue: {},
      webPush: {
        supported: true,
        permission: "default",
        subscribed: false,
        loading: false,
      },
    });

    expect(sectionTabLabels(container)).toContain("Notifications");

    selectConfigTab(container, "__notifications__");
    expect(onSectionChange).toHaveBeenCalledWith("__notifications__");
  });

  it("renders Notifications with the shared settings card and button styles", () => {
    const onWebPushSubscribe = vi.fn();
    const { container } = renderConfigView({
      activeSection: "__notifications__",
      includeSections: ["__notifications__"],
      includeVirtualSections: true,
      showModeToggle: false,
      showRootTab: false,
      onWebPushSubscribe,
      schema: {
        type: "object",
        properties: {},
      },
      webPush: {
        supported: true,
        permission: "default",
        subscribed: false,
        loading: false,
      },
    });

    const card = queryRequired(container, "#settings-communications-notifications", HTMLElement);
    expect(container.querySelector(".config-toolbar")).toBeNull();
    expect(container.textContent).not.toContain("Saved");
    expect(
      card.querySelector(".settings-section__actions .settings-status")?.textContent?.trim(),
    ).toBe("Ready");

    const enableButton = findButtonByText(container, "Enable notifications");
    expect(enableButton.classList.contains("btn")).toBe(true);
    expect(enableButton.classList.contains("primary")).toBe(true);
    expect(container.querySelector(".config-bar__btn")).toBeNull();

    enableButton.click();
    expect(onWebPushSubscribe).toHaveBeenCalledOnce();
  });

  it("resets config content scroll when switching top-tab sections", async () => {
    const { container } = renderConfigView({
      activeSection: "channels",
      navRootLabel: "Communication",
      includeSections: ["channels", "messages"],
      schema: {
        type: "object",
        properties: {
          channels: {
            type: "object",
            properties: {
              telegram: { type: "string" },
            },
          },
          messages: {
            type: "object",
            properties: {
              inbox: { type: "string" },
            },
          },
        },
      },
      uiHints: { "channels.telegram": { advanced: false } },
      formValue: {
        channels: { telegram: "on" },
        messages: { inbox: "smart" },
      },
      originalValue: {
        channels: { telegram: "on" },
        messages: { inbox: "smart" },
      },
    });

    const content = queryRequired(container, ".config-content", HTMLElement);
    content.scrollTop = 280;
    content.scrollLeft = 24;
    content.scrollTo = vi.fn(({ top, left }: { top?: number; left?: number }) => {
      content.scrollTop = top ?? content.scrollTop;
      content.scrollLeft = left ?? content.scrollLeft;
    }) as typeof content.scrollTo;

    selectConfigTab(container, "messages");
    await Promise.resolve();

    expect(content["scrollTo"]).toHaveBeenCalledOnce();
    expect(content["scrollTo"]).toHaveBeenCalledWith({ top: 0, left: 0, behavior: "auto" });
    expect(content.scrollTop).toBe(0);
    expect(content.scrollLeft).toBe(0);
  });

  it("resets config content scroll when switching from form to raw mode", async () => {
    const container = document.createElement("div");
    document.body.append(container);

    try {
      const viewState = createConfigViewState();
      const renderCase = (overrides: Partial<ConfigProps>) =>
        render(renderConfig({ ...baseProps(), viewState, ...overrides }), container);

      renderCase({ formMode: "form" });

      const content = queryRequired(container, ".config-content", HTMLElement);
      content.scrollTop = 320;
      content.scrollLeft = 18;
      content.scrollTo = vi.fn(({ top, left }: { top?: number; left?: number }) => {
        content.scrollTop = top ?? content.scrollTop;
        content.scrollLeft = left ?? content.scrollLeft;
      }) as typeof content.scrollTo;

      renderCase({ formMode: "raw" });
      await Promise.resolve();

      expect(content["scrollTo"]).toHaveBeenCalledOnce();
      expect(content["scrollTo"]).toHaveBeenCalledWith({ top: 0, left: 0, behavior: "auto" });
      expect(content.scrollTop).toBe(0);
      expect(content.scrollLeft).toBe(0);
    } finally {
      container.remove();
    }
  });

  it("can hide the root tab for scoped settings surfaces", () => {
    const { container } = renderConfigView({
      activeSection: "channels",
      navRootLabel: "Communication",
      showRootTab: false,
      includeSections: ["channels", "messages"],
      schema: {
        type: "object",
        properties: {
          channels: { type: "object", properties: {} },
          messages: { type: "object", properties: {} },
        },
      },
    });

    expect(sectionTabLabels(container)).toEqual(["Channels", "Messages"]);
  });

  it("does not normalize off-scope schema sections for scoped config tabs", () => {
    const offScopeSchema = { type: "object" } as Record<string, unknown>;
    Object.defineProperty(offScopeSchema, "properties", {
      get() {
        throw new Error("off-scope schema was normalized");
      },
    });

    const { container } = renderConfigView({
      activeSection: "channels",
      navRootLabel: "Communication",
      includeSections: ["channels"],
      schema: {
        type: "object",
        properties: {
          channels: {
            type: "object",
            properties: {
              telegram: { type: "string", title: "Telegram" },
            },
          },
          models: offScopeSchema,
        },
      },
      uiHints: { "channels.telegram": { advanced: false } },
      formValue: {
        channels: { telegram: "enabled" },
        models: {},
      },
      originalValue: {
        channels: { telegram: "enabled" },
        models: {},
      },
    });

    expect(
      Array.from(container.querySelectorAll(".settings-row__title")).map((label) =>
        label.textContent?.trim(),
      ),
    ).toEqual(["Telegram"]);
  });

  it("shows the section heading outside the group in single-section form view", () => {
    const { container } = renderConfigView({
      activeSection: "auth",
      schema: {
        type: "object",
        properties: {
          auth: {
            type: "object",
            properties: {
              order: {
                type: "object",
              },
            },
          },
        },
      },
      uiHints: { "auth.order": { advanced: false } },
      formValue: {
        auth: {
          order: {},
        },
      },
      originalValue: {
        auth: {
          order: {},
        },
      },
    });

    const headings = Array.from(container.querySelectorAll(".settings-section__heading")).map(
      (heading) => heading.textContent?.trim(),
    );
    expect(headings).toEqual(["Authentication"]);
    const section = container.querySelector("#config-section-auth");
    expect(section?.querySelector(".settings-group")).not.toBeNull();
    // The heading lives outside the group surface.
    expect(section?.querySelector(".settings-group .settings-section__heading")).toBeNull();
  });

  it("keeps section headings in multi-section root view", () => {
    const { container } = renderConfigView({
      schema: {
        type: "object",
        properties: {
          auth: {
            type: "object",
            properties: {},
          },
          gateway: {
            type: "object",
            properties: {},
          },
        },
      },
      formValue: {
        auth: {},
        gateway: {},
      },
      originalValue: {
        auth: {},
        gateway: {},
      },
    });

    expect(
      [...container.querySelectorAll(".settings-section__heading")].map((title) =>
        title.textContent?.trim(),
      ),
    ).toEqual(["Authentication", "Gateway"]);
  });

  it("keeps sensitive raw config hidden until reveal before editing", () => {
    const onRawChange = vi.fn();
    const { container } = renderConfigView({
      formMode: "raw",
      raw: '{\n  "openai": { "apiKey": "supersecret" }\n}\n',
      originalRaw: '{\n  "openai": { "apiKey": "supersecret" }\n}\n',
      formValue: {
        openai: {
          apiKey: "supersecret",
        },
      },
      onRawChange,
    });

    expect(
      queryRequired(container, ".config-raw-field .settings-count", HTMLElement)
        .textContent?.replace(/\s+/g, " ")
        .trim(),
    ).toBe("1 secret redacted");
    expect(
      queryRequired(container, ".config-raw-field .callout.info", HTMLElement)
        .textContent?.replace(/\s+/g, " ")
        .trim(),
    ).toBe("1 sensitive value hidden. Use the reveal button above to edit the raw config.");
    expect(container.querySelector("textarea")).toBeNull();

    const revealButton = queryRequired(container, ".config-raw-toggle", HTMLButtonElement);
    expect(revealButton.getAttribute("aria-pressed")).toBe("false");
    revealButton.click();

    const textarea = queryRequired(container, "textarea", HTMLTextAreaElement);
    expect(textarea.value).toBe('{\n  "openai": { "apiKey": "supersecret" }\n}\n');
    textarea.value = textarea.value.replace("supersecret", "updatedsecret");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onRawChange).toHaveBeenCalledWith(textarea.value);
  });

  it("opens raw pending changes without sending a fake raw edit", () => {
    const container = document.createElement("div");
    const onRawChange = vi.fn();
    let updateCount = 0;
    const props: ConfigProps = {
      ...baseProps(),
      formMode: "raw",
      raw: '{\n  gateway: { mode: "remote" }\n}\n',
      originalRaw: '{\n  gateway: { mode: "local" }\n}\n',
      formValue: {
        gateway: {
          mode: "remote",
        },
      },
      originalValue: {
        gateway: {
          mode: "local",
        },
      },
      onRawChange,
    };
    const rerender = () =>
      render(
        renderConfig({
          ...props,
          onViewStateChange: () => {
            updateCount += 1;
            rerender();
          },
        }),
        container,
      );
    rerender();

    const details = queryRequired(container, ".config-diff", HTMLDetailsElement);
    expect(details.querySelector(".config-diff__summary span")?.textContent?.trim()).toBe(
      "View pending changes",
    );
    expect(details.querySelector(".config-diff__item")?.textContent?.trim()).toBe(
      "Changes detected (JSON diff not available)",
    );
    details.open = true;
    details.dispatchEvent(new Event("toggle"));

    expect(updateCount).toBe(1);
    expect(onRawChange).not.toHaveBeenCalled();
    const item = queryRequired(container, ".config-diff__item", HTMLElement);
    expect(item.querySelector(".config-diff__path")?.textContent?.trim()).toBe("gateway.mode");
    expect(item.querySelector(".config-diff__from")?.textContent?.trim()).toBe('"local"');
    expect(item.querySelector(".config-diff__to")?.textContent?.trim()).toBe('"remote"');
  });

  it("does not render a pending-changes panel for form drafts (they auto-save)", () => {
    const { container } = renderConfigView({
      formValue: { boundary: "after" },
      originalValue: { boundary: "before" },
    });

    expect(container.querySelector(".config-diff")).toBeNull();
  });

  it("redacts sensitive values in raw pending changes until raw values are revealed", () => {
    const container = document.createElement("div");
    const props: ConfigProps = {
      ...baseProps(),
      formMode: "raw",
      raw: '{\n  channels: { discord: { token: { id: "TOKEN_AFTER" } } }\n}\n',
      originalRaw: '{\n  channels: { discord: { token: { id: "TOKEN_BEFORE" } } }\n}\n',
      uiHints: {
        "channels.discord.token": { sensitive: true, advanced: false },
      },
      formValue: {
        channels: {
          discord: {
            token: {
              id: "TOKEN_AFTER",
            },
          },
        },
      },
      originalValue: {
        channels: {
          discord: {
            token: {
              id: "TOKEN_BEFORE",
            },
          },
        },
      },
    };
    const rerender = () =>
      render(
        renderConfig({
          ...props,
          onViewStateChange: rerender,
        }),
        container,
      );
    rerender();

    const details = queryRequired(container, ".config-diff", HTMLDetailsElement);
    details.open = true;
    details.dispatchEvent(new Event("toggle"));

    const item = queryRequired(container, ".config-diff__item", HTMLElement);
    expect(item.querySelector(".config-diff__path")?.textContent?.trim()).toBe(
      "channels.discord.token.id",
    );
    expect(item.querySelector(".config-diff__from")?.textContent?.trim()).toBe(
      "[redacted - click reveal to view]",
    );
    expect(item.querySelector(".config-diff__to")?.textContent?.trim()).toBe(
      "[redacted - click reveal to view]",
    );

    const revealButton = queryRequired(container, ".config-raw-toggle", HTMLButtonElement);
    revealButton.click();

    expect(item.querySelector(".config-diff__from")?.textContent?.trim()).toBe('"TOKEN_BEFORE"');
    expect(item.querySelector(".config-diff__to")?.textContent?.trim()).toBe('"TOKEN_AFTER"');
  });

  it("resets raw reveal state when the config context changes", () => {
    const container = document.createElement("div");
    const props: ConfigProps = {
      ...baseProps(),
      configPath: "/tmp/openclaw-a.json5",
      formMode: "raw",
      raw: '{\n  token: "TOKEN_A_AFTER"\n}\n',
      originalRaw: '{\n  token: "TOKEN_A_BEFORE"\n}\n',
      uiHints: {
        token: { sensitive: true },
      },
      formValue: {
        token: "TOKEN_A_AFTER",
      },
      originalValue: {
        token: "TOKEN_A_BEFORE",
      },
    };
    const rerender = () =>
      render(
        renderConfig({
          ...props,
          onViewStateChange: rerender,
        }),
        container,
      );
    rerender();

    const details = queryRequired(container, ".config-diff", HTMLDetailsElement);
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    const revealButton = queryRequired(container, ".config-raw-toggle", HTMLButtonElement);
    revealButton.click();
    const revealedItem = queryRequired(container, ".config-diff__item", HTMLElement);
    expect(revealedItem.querySelector(".config-diff__path")?.textContent?.trim()).toBe("token");
    expect(revealedItem.querySelector(".config-diff__from")?.textContent?.trim()).toBe(
      '"TOKEN_A_BEFORE"',
    );
    expect(revealedItem.querySelector(".config-diff__to")?.textContent?.trim()).toBe(
      '"TOKEN_A_AFTER"',
    );

    props.configPath = "/tmp/openclaw-b.json5";
    props.raw = '{\n  token: "TOKEN_B_AFTER"\n}\n';
    props.originalRaw = '{\n  token: "TOKEN_B_BEFORE"\n}\n';
    props.formValue = {
      token: "TOKEN_B_AFTER",
    };
    props.originalValue = {
      token: "TOKEN_B_BEFORE",
    };
    rerender();

    expect(
      queryRequired(container, ".config-raw-field .settings-count", HTMLElement)
        .textContent?.replace(/\s+/g, " ")
        .trim(),
    ).toBe("1 secret redacted");
    expect(
      queryRequired(container, ".config-raw-field .callout.info", HTMLElement)
        .textContent?.replace(/\s+/g, " ")
        .trim(),
    ).toBe("1 sensitive value hidden. Use the reveal button above to edit the raw config.");
    expect(container.querySelector("textarea")).toBeNull();
    const nextDetails = queryRequired(container, ".config-diff", HTMLDetailsElement);
    expect(nextDetails.open).toBe(false);

    nextDetails.open = true;
    nextDetails.dispatchEvent(new Event("toggle"));
    const redactedItem = queryRequired(container, ".config-diff__item", HTMLElement);
    expect(redactedItem.querySelector(".config-diff__path")?.textContent?.trim()).toBe("token");
    expect(redactedItem.querySelector(".config-diff__from")?.textContent?.trim()).toBe(
      "[redacted - click reveal to view]",
    );
    expect(redactedItem.querySelector(".config-diff__to")?.textContent?.trim()).toBe(
      "[redacted - click reveal to view]",
    );
  });

  it("redacts raw diff values under leaf wildcard sensitive hints when keys contain dots", () => {
    const container = document.createElement("div");
    const props: ConfigProps = {
      ...baseProps(),
      formMode: "raw",
      raw: '{\n  integrations: { "foo.bar": { credential: "TOKEN_AFTER" } }\n}\n',
      originalRaw: '{\n  integrations: { "foo.bar": { credential: "TOKEN_BEFORE" } }\n}\n',
      uiHints: {
        "integrations.*.credential": { sensitive: true },
      },
      formValue: {
        integrations: {
          "foo.bar": {
            credential: "TOKEN_AFTER",
          },
        },
      },
      originalValue: {
        integrations: {
          "foo.bar": {
            credential: "TOKEN_BEFORE",
          },
        },
      },
    };
    const rerender = () =>
      render(
        renderConfig({
          ...props,
          onViewStateChange: rerender,
        }),
        container,
      );
    rerender();

    const details = queryRequired(container, ".config-diff", HTMLDetailsElement);
    details.open = true;
    details.dispatchEvent(new Event("toggle"));

    const item = queryRequired(container, ".config-diff__item", HTMLElement);
    expect(item.querySelector(".config-diff__path")?.textContent?.trim()).toBe(
      "integrations.foo.bar.credential",
    );
    expect(item.querySelector(".config-diff__from")?.textContent?.trim()).toBe(
      "[redacted - click reveal to view]",
    );
    expect(item.querySelector(".config-diff__to")?.textContent?.trim()).toBe(
      "[redacted - click reveal to view]",
    );
  });

  it("removes the raw pending changes panel after raw changes clear", () => {
    const container = document.createElement("div");
    const props: ConfigProps = {
      ...baseProps(),
      formMode: "raw",
      raw: '{\n  gateway: { mode: "remote" }\n}\n',
      originalRaw: '{\n  gateway: { mode: "local" }\n}\n',
      formValue: {
        gateway: {
          mode: "remote",
        },
      },
      originalValue: {
        gateway: {
          mode: "local",
        },
      },
    };
    const rerender = () =>
      render(
        renderConfig({
          ...props,
          onViewStateChange: rerender,
        }),
        container,
      );
    rerender();

    const details = queryRequired(container, ".config-diff", HTMLDetailsElement);
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    expect(
      queryRequired(container, ".config-diff__item", HTMLElement)
        .querySelector(".config-diff__path")
        ?.textContent?.trim(),
    ).toBe("gateway.mode");

    props.raw = props.originalRaw;
    props.formValue = props.originalValue;
    rerender();

    expect(container.querySelector(".config-diff")).toBeNull();
  });

  it("renders structured SecretRef values without stringifying", () => {
    const onFormPatch = vi.fn();
    const secretRefSchema = {
      type: "object" as const,
      properties: {
        channels: {
          type: "object" as const,
          properties: {
            discord: {
              type: "object" as const,
              properties: {
                token: { type: "string" as const },
              },
            },
          },
        },
      },
    };
    const secretRefValue = {
      channels: {
        discord: {
          token: { source: "env", provider: "default", id: "__OPENCLAW_REDACTED__" },
        },
      },
    };
    const secretRefOriginalValue = {
      channels: {
        discord: {
          token: { source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" },
        },
      },
    };
    const { container } = renderConfigView({
      schema: secretRefSchema,
      uiHints: {
        "channels.discord.token": { sensitive: true, advanced: false },
      },
      formMode: "form",
      formValue: secretRefValue,
      originalValue: secretRefOriginalValue,
      onFormPatch,
    });

    const input = queryRequired(container, ".settings-input", HTMLInputElement);
    expect(input.readOnly).toBe(true);
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("Structured value (SecretRef) - use Raw mode to edit");
    input.value = "[object Object]";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onFormPatch).not.toHaveBeenCalled();

    render(
      renderConfig({
        ...baseProps(),
        rawAvailable: false,
        formMode: "raw",
        schema: secretRefSchema,
        uiHints: {
          "channels.discord.token": { sensitive: true, advanced: false },
        },
        formValue: secretRefValue,
        originalValue: secretRefOriginalValue,
      }),
      container,
    );

    const rawUnavailableInput = queryRequired(container, ".settings-input", HTMLInputElement);
    expect(rawUnavailableInput.placeholder).toBe(
      "Structured value (SecretRef) - edit the config file directly",
    );
  });

  it("keeps malformed non-SecretRef object values editable when raw mode is unavailable", () => {
    const onFormPatch = vi.fn();
    const { container } = renderConfigView({
      rawAvailable: false,
      formMode: "raw",
      schema: {
        type: "object",
        properties: {
          gateway: {
            type: "object",
            properties: {
              mode: { type: "string" },
            },
          },
        },
      },
      uiHints: { "gateway.mode": { advanced: false } },
      formValue: {
        gateway: {
          mode: { malformed: true },
        },
      },
      originalValue: {
        gateway: {
          mode: { malformed: true },
        },
      },
      onFormPatch,
    });

    const input = container.querySelector<HTMLInputElement>(".settings-input");
    expect(input).toBeInstanceOf(HTMLInputElement);
    expect(input?.readOnly).toBe(false);
    expect(input?.value).toBe('{  "malformed": true}');
    expect(input?.value).not.toBe("[object Object]");
    expect(input?.placeholder).toBe("");

    if (!input) {
      return;
    }
    input.value = "local";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onFormPatch).toHaveBeenCalledWith(["gateway", "mode"], "local");
  });

  it("opens the tweakcn importer when custom is clicked without an imported theme", () => {
    const onOpenCustomThemeImport = vi.fn();
    const { container } = renderConfigView({
      activeSection: "__appearance__",
      includeSections: ["__appearance__"],
      onOpenCustomThemeImport,
    });

    const customButton = findButtonByText(container, "Import");

    expect(customButton.disabled).toBe(false);
    expect(customButton.hasAttribute("aria-pressed")).toBe(false);
    expect(
      normalizedText(
        queryRequired(container, ".settings-theme-import__inline-hint", HTMLParagraphElement),
      ),
    ).toBe(
      "Click Import to add one browser-local tweakcn theme. In tweakcn, use Share and paste the copied link here.",
    );

    customButton.click();

    expect(onOpenCustomThemeImport).toHaveBeenCalledTimes(1);
  });

  it("exposes theme and text-size selection to assistive technology", () => {
    const { container } = renderConfigView({
      activeSection: "__appearance__",
      includeSections: ["__appearance__"],
      theme: "knot",
      textScale: 110,
    });

    expect(findButtonByText(container, "Knot").getAttribute("aria-pressed")).toBe("true");
    expect(findButtonByText(container, "Claw").getAttribute("aria-pressed")).toBe("false");
    const textScaleButtons = [
      ...container.querySelectorAll<HTMLButtonElement>(".settings-text-scale__btn"),
    ];
    expect(
      textScaleButtons
        .find((button) => button.textContent?.includes("110%"))
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      textScaleButtons
        .find((button) => button.textContent?.includes("100%"))
        ?.getAttribute("aria-pressed"),
    ).toBe("false");

    const { container: customContainer } = renderConfigView({
      activeSection: "__appearance__",
      includeSections: ["__appearance__"],
      hasCustomTheme: true,
      customThemeLabel: "Light Green",
      theme: "custom",
    });
    expect(findButtonByText(customContainer, "Light Green").getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(findButtonByText(customContainer, "Claw").getAttribute("aria-pressed")).toBe("false");
  });

  it("shows Appearance defaults without reset actions", () => {
    const { container } = renderConfigView({
      activeSection: "__appearance__",
      includeSections: ["__appearance__"],
      lobsterPetVisits: true,
      setLobsterPetVisits: vi.fn(),
      lobsterPetSounds: false,
      setLobsterPetSounds: vi.fn(),
      composerHoldToRecord: true,
      setComposerHoldToRecord: vi.fn(),
    });
    const text = normalizedText(container);

    for (const expected of [
      "Using default: System",
      "Using default: Claw",
      "Using default: 100%",
      "Using default: Enabled",
      "Using default: 48rem",
      "Using default: Enter",
      "Using default: OpenClaw viewer",
      "Using default: Disabled",
    ]) {
      expect(text).toContain(expected);
    }
    const lobsterPreviews = container.querySelectorAll(".lobsterdex__mini");
    expect(lobsterPreviews).toHaveLength(42);
    expect([...lobsterPreviews].every((preview) => preview.getAttribute("role") === "img")).toBe(
      true,
    );
    expect(
      [...lobsterPreviews].every((preview) => Boolean(preview.getAttribute("aria-label")?.trim())),
    ).toBe(true);
    expect(container.querySelector('button[aria-label="Reset to default"]')).toBeNull();
  });

  it("resets every explicit Appearance override independently", () => {
    const resetLocale = vi.fn();
    const setTheme = vi.fn();
    const resetTheme = vi.fn();
    const setThemeMode = vi.fn();
    const resetThemeMode = vi.fn();
    const setTextScale = vi.fn();
    const resetTextScale = vi.fn();
    const setSidebarLiveActivity = vi.fn();
    const setChatMessageMaxWidth = vi.fn();
    const setChatSendShortcut = vi.fn();
    const resetChatSendShortcut = vi.fn();
    const setCatalogOpenTarget = vi.fn();
    const setComposerHoldToRecord = vi.fn();
    const setLobsterPetVisits = vi.fn();
    const setLobsterPetSounds = vi.fn();
    const { container } = renderConfigView({
      activeSection: "__appearance__",
      includeSections: ["__appearance__"],
      systemLocale: "de",
      localeOverride: "pt-BR",
      localeOverridden: true,
      resetLocale,
      theme: "knot",
      themeOverridden: true,
      setTheme,
      resetTheme,
      themeMode: "dark",
      themeModeOverridden: true,
      setThemeMode,
      resetThemeMode,
      textScale: 110,
      textScaleOverridden: true,
      setTextScale,
      resetTextScale,
      sidebarLiveActivity: false,
      setSidebarLiveActivity,
      chatMessageMaxWidth: "82%",
      setChatMessageMaxWidth,
      chatSendShortcut: "modifier-enter",
      chatSendShortcutOverridden: true,
      setChatSendShortcut,
      resetChatSendShortcut,
      catalogOpenTarget: "terminal",
      setCatalogOpenTarget,
      composerHoldToRecord: false,
      setComposerHoldToRecord,
      lobsterPetVisits: false,
      setLobsterPetVisits,
      lobsterPetSounds: true,
      setLobsterPetSounds,
    });
    const resetIn = (element: Element | null) => {
      const button = element?.querySelector<HTMLButtonElement>(
        'button[aria-label="Reset to default"]',
      );
      expect(button).not.toBeNull();
      button?.click();
    };
    const row = (title: string) =>
      Array.from(container.querySelectorAll<HTMLElement>(".settings-row")).find(
        (candidate) =>
          candidate.querySelector(".settings-row__title")?.textContent?.trim() === title,
      ) ?? null;

    resetIn(container.querySelector("#settings-language .settings-row"));
    resetIn(container.querySelector("#settings-appearance-theme > .settings-section__header"));
    resetIn(row("Color mode"));
    resetIn(container.querySelector("#settings-appearance-text-size > .settings-section__header"));
    resetIn(row("Show live agent activity in sidebar"));
    resetIn(row("Message width"));
    resetIn(row("Send shortcut"));
    resetIn(row("Open external sessions in"));
    resetIn(row("Hold microphone button to dictate"));
    resetIn(row("Lobster visits"));
    resetIn(row("Lobster sounds"));

    expect(resetLocale).toHaveBeenCalledOnce();
    expect(resetTheme).toHaveBeenCalledOnce();
    expect(resetThemeMode).toHaveBeenCalledOnce();
    expect(resetTextScale).toHaveBeenCalledOnce();
    expect(setSidebarLiveActivity).toHaveBeenCalledWith(true);
    expect(setChatMessageMaxWidth).toHaveBeenCalledWith(undefined);
    expect(resetChatSendShortcut).toHaveBeenCalledOnce();
    expect(setCatalogOpenTarget).toHaveBeenCalledWith("viewer");
    expect(setComposerHoldToRecord).toHaveBeenCalledWith(true);
    expect(setLobsterPetVisits).toHaveBeenCalledWith(true);
    expect(setLobsterPetSounds).toHaveBeenCalledWith(false);
  });

  it("shows reset actions for authored synced values equal to product defaults", () => {
    const resetTheme = vi.fn();
    const resetThemeMode = vi.fn();
    const resetChatSendShortcut = vi.fn();
    const { container } = renderConfigView({
      activeSection: "__appearance__",
      includeSections: ["__appearance__"],
      theme: "claw",
      themeOverridden: true,
      themeProvenance: "synced",
      resetTheme,
      themeMode: "system",
      themeModeOverridden: true,
      themeModeProvenance: "synced",
      resetThemeMode,
      chatSendShortcut: "enter",
      chatSendShortcutOverridden: true,
      chatSendShortcutProvenance: "synced",
      resetChatSendShortcut,
    });
    const themeSection = queryRequired(container, "#settings-appearance-theme", HTMLElement);
    const shortcutRow = Array.from(container.querySelectorAll<HTMLElement>(".settings-row")).find(
      (candidate) =>
        candidate.querySelector(".settings-row__title")?.textContent?.trim() === "Send shortcut",
    );

    expect(normalizedText(themeSection)).toContain("Default: Claw");
    expect(normalizedText(themeSection)).toContain("Default: System");
    expect(shortcutRow?.textContent).toContain("Default: Enter");
    themeSection
      .querySelector<HTMLButtonElement>(
        ":scope > .settings-section__header button[aria-label='Reset to default']",
      )
      ?.click();
    const colorModeRow = Array.from(
      themeSection.querySelectorAll<HTMLElement>(".settings-row"),
    ).find(
      (candidate) =>
        candidate.querySelector(".settings-row__title")?.textContent?.trim() === "Color mode",
    );
    colorModeRow
      ?.querySelector<HTMLButtonElement>("button[aria-label='Reset to default']")
      ?.click();
    shortcutRow?.querySelector<HTMLButtonElement>("button[aria-label='Reset to default']")?.click();

    expect(resetTheme).toHaveBeenCalledOnce();
    expect(resetThemeMode).toHaveBeenCalledOnce();
    expect(resetChatSendShortcut).toHaveBeenCalledOnce();
  });

  it("renders rejected theme and locale edits as resettable browser-only fallbacks", () => {
    const resetLocale = vi.fn();
    const resetTheme = vi.fn();
    const { container } = renderConfigView({
      activeSection: "__appearance__",
      includeSections: ["__appearance__"],
      localeOverride: "fr",
      localeOverridden: true,
      localeProvenance: "device-local",
      localeResetValue: "de",
      resetLocale,
      theme: "knot",
      themeOverridden: true,
      themeProvenance: "device-local",
      themeResetValue: "claw",
      resetTheme,
    });
    const languageRow = queryRequired(container, "#settings-language .settings-row", HTMLElement);
    const themeSection = queryRequired(container, "#settings-appearance-theme", HTMLElement);
    const themeDescription = queryRequired(
      themeSection,
      ":scope > .settings-section__desc",
      HTMLElement,
    );

    expect(languageRow.textContent).toContain("Default: Deutsch (German)");
    expect(languageRow.textContent).toContain("Stored in this browser only");
    expect(languageRow.textContent).not.toContain("Synced across your devices");
    expect(
      (
        languageRow.querySelector('wa-option[value="fr"]') as HTMLElement & {
          selected: boolean;
        }
      ).selected,
    ).toBe(true);
    expect(themeDescription.textContent).toContain("Default: Claw");
    expect(themeDescription.textContent).toContain("Stored in this browser only");
    expect(themeDescription.textContent).not.toContain("Synced across your devices");
    expect(
      themeSection.querySelector(".settings-theme-card--knot")?.getAttribute("aria-pressed"),
    ).toBe("true");

    languageRow.querySelector<HTMLButtonElement>('button[aria-label="Reset to default"]')?.click();
    themeSection
      .querySelector<HTMLButtonElement>(
        ":scope > .settings-section__header button[aria-label='Reset to default']",
      )
      ?.click();

    expect(resetLocale).toHaveBeenCalledOnce();
    expect(resetTheme).toHaveBeenCalledOnce();
  });

  it("shows pending synced preferences without claiming they already synced", () => {
    const { container } = renderConfigView({
      activeSection: "__appearance__",
      includeSections: ["__appearance__"],
      theme: "claw",
      themeOverridden: false,
      themeProvenance: "pending",
      chatFollowUpMode: "queue",
      chatFollowUpModeOverridden: true,
      chatFollowUpModeProvenance: "pending",
    });
    const themeSection = queryRequired(container, "#settings-appearance-theme", HTMLElement);
    const themeDescription = queryRequired(
      themeSection,
      ":scope > .settings-section__desc",
      HTMLElement,
    );
    const followUpRow = Array.from(container.querySelectorAll<HTMLElement>(".settings-row")).find(
      (candidate) =>
        candidate.querySelector(".settings-row__title")?.textContent?.trim() ===
        "Follow-ups while the agent is working",
    );

    expect(themeDescription.textContent).toContain("Waiting to sync through the gateway");
    expect(themeDescription.textContent).not.toContain("Synced across your devices");
    expect(followUpRow?.textContent).toContain("Waiting to sync through the gateway");
    expect(followUpRow?.textContent).not.toContain("Synced across your devices");
  });

  it("labels synced and browser-only Chat preferences per row", () => {
    const { container } = renderConfigView({
      activeSection: "__appearance__",
      includeSections: ["__appearance__"],
      composerHoldToRecord: true,
      setComposerHoldToRecord: vi.fn(),
    });
    const chat = queryRequired(container, "#settings-appearance-chat", HTMLElement);
    const sectionDescription = Array.from(chat.children).find((child) =>
      child.classList.contains("settings-section__desc"),
    );
    const row = (title: string) =>
      Array.from(chat.querySelectorAll<HTMLElement>(".settings-row")).find(
        (candidate) =>
          candidate.querySelector(".settings-row__title")?.textContent?.trim() === title,
      );

    expect(sectionDescription).toBeUndefined();
    expect(row("Send shortcut")?.textContent).toContain("Synced across your devices");
    expect(row("Follow-ups while the agent is working")?.textContent).toContain(
      "Synced across your devices",
    );
    for (const title of [
      "Message width",
      "Open external sessions in",
      "Hold microphone button to dictate",
    ]) {
      expect(row(title)?.textContent).toContain("Stored in this browser only");
      expect(row(title)?.textContent).not.toContain("Synced across your devices");
    }
  });

  it("shows the tweakcn importer once the custom slot is opened", () => {
    const { container } = renderConfigView({
      activeSection: "__appearance__",
      includeSections: ["__appearance__"],
      customThemeImportExpanded: true,
      customThemeImportFocusToken: 1,
    });

    const importButton = findButtonContainingText(container, "Import theme");

    expect(importButton.disabled).toBe(true);
    queryRequired(container, ".settings-theme-import__input", HTMLInputElement);
    expect(
      container.querySelector<HTMLAnchorElement>(".settings-theme-import__external")?.href,
    ).toBe("https://tweakcn.com/editor/theme");
    expect(
      normalizedText(
        queryRequired(container, ".settings-theme-import__hint", HTMLParagraphElement),
      ),
    ).toBe(
      "Open tweakcn.com, choose or create a theme, click Share, then paste the copied theme link here. Share links, editor URLs, registry URLs, theme IDs, and default theme names like amethyst-haze are accepted.",
    );
  });

  it("shows custom theme actions once a tweakcn import exists", () => {
    const setTheme = vi.fn();
    const onClearCustomTheme = vi.fn();
    const onImportCustomTheme = vi.fn();
    const onCustomThemeImportUrlChange = vi.fn();
    const { container } = renderConfigView({
      activeSection: "__appearance__",
      includeSections: ["__appearance__"],
      hasCustomTheme: true,
      customThemeLabel: "Light Green",
      customThemeSourceUrl: "https://tweakcn.com/themes/cmlhfpjhw000004l4f4ax3m7z",
      customThemeImportUrl: "https://tweakcn.com/themes/cmlhfpjhw000004l4f4ax3m7z",
      setTheme,
      onClearCustomTheme,
      onImportCustomTheme,
      onCustomThemeImportUrlChange,
    });

    const customButton = findButtonByText(container, "Light Green");
    expect(customButton.disabled).toBe(false);
    customButton.click();
    expect(setTheme).toHaveBeenCalledWith("custom", { element: customButton });

    const replaceButton = findButtonContainingText(container, "Replace Light Green");
    const clearButton = findButtonContainingText(container, "Clear Light Green");
    replaceButton.click();
    clearButton.click();

    expect(onImportCustomTheme).toHaveBeenCalledTimes(1);
    expect(onClearCustomTheme).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".settings-theme-import__meta-label")?.textContent?.trim()).toBe(
      "Loaded",
    );
    expect(container.querySelector(".settings-theme-import__meta-value")?.textContent?.trim()).toBe(
      "Light Green \u00b7 https://tweakcn.com/themes/cmlhfpjhw000004l4f4ax3m7z",
    );

    const input = container.querySelector(".settings-theme-import__input") as HTMLInputElement;
    input.value = "/r/themes/cmlhfpjhw000004l4f4ax3m7z";
    input.dispatchEvent(new Event("input"));
    expect(onCustomThemeImportUrlChange).toHaveBeenCalledWith(
      "/r/themes/cmlhfpjhw000004l4f4ax3m7z",
    );
  });

  it("names the chat preference selects for assistive tech", () => {
    const onMicrophoneRefresh = vi.fn();
    const onCameraRefresh = vi.fn();
    const { container } = renderConfigView({
      activeSection: "__appearance__",
      includeSections: ["__appearance__"],
      microphone: {
        devices: [{ deviceId: "mic-1", label: "Desk Mic" }],
        permissionRequired: false,
        selectedDeviceId: "mic-1",
        loading: false,
        error: null,
      },
      onMicrophoneSelect: vi.fn(),
      onMicrophoneRefresh,
      camera: {
        devices: [{ deviceId: "camera-1", label: "Desk Camera" }],
        permissionRequired: false,
        selectedDeviceId: "camera-1",
        loading: false,
        error: null,
      },
      onCameraSelect: vi.fn(),
      onCameraRefresh,
      composerHoldToRecord: true,
      setComposerHoldToRecord: vi.fn(),
    });

    const shortcutSelect = queryRequired(
      container,
      "[data-settings-send-shortcut]",
      HTMLSelectElement,
    );
    expect(shortcutSelect.getAttribute("aria-label")).toBe("Send shortcut");
    const followUpSelect = queryRequired(
      container,
      "[data-settings-follow-up-mode]",
      HTMLSelectElement,
    );
    expect(followUpSelect.getAttribute("aria-label")).toBe("Follow-ups while the agent is working");
    expect(followUpSelect.value).toBe("server");
    expect(Array.from(followUpSelect.options, (option) => option.value)).toEqual([
      "server",
      "steer",
      "queue",
    ]);
    expect(container.textContent).toContain("Using server default (steer)");
    const microphoneSelect = queryRequired(
      container,
      "[data-settings-microphone]",
      HTMLSelectElement,
    );
    expect(microphoneSelect.getAttribute("aria-label")).toBe("Microphone input");
    expect(microphoneSelect.classList.contains("settings-select--media-device")).toBe(true);
    const cameraSelect = queryRequired(container, "[data-settings-camera]", HTMLSelectElement);
    expect(cameraSelect.getAttribute("aria-label")).toBe("Camera");
    expect(cameraSelect.classList.contains("settings-select--media-device")).toBe(true);
    expect(Array.from(cameraSelect.options, (option) => option.textContent?.trim())).toEqual([
      "System default",
      "Desk Camera",
    ]);
    expect(container.textContent).toContain("Hold microphone button to dictate");

    microphoneSelect.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    cameraSelect.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    expect(onMicrophoneRefresh).not.toHaveBeenCalled();
    expect(onCameraRefresh).not.toHaveBeenCalled();
  });

  it("requests media access for each native picker opening gesture", () => {
    const cases = [
      {
        devices: [{ deviceId: "anonymous", label: "Microphone 1" }],
        gesture: new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
      },
      { devices: [], gesture: new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) },
      { devices: [], gesture: new KeyboardEvent("keydown", { key: "F4", bubbles: true }) },
    ];

    for (const { devices, gesture } of cases) {
      const onMicrophoneRefresh = vi.fn();
      const { container } = renderConfigView({
        activeSection: "__appearance__",
        includeSections: ["__appearance__"],
        microphone: {
          devices,
          permissionRequired: true,
          selectedDeviceId: "",
          loading: false,
          error: null,
        },
        onMicrophoneSelect: vi.fn(),
        onMicrophoneRefresh,
      });
      const microphoneSelect = queryRequired(
        container,
        "[data-settings-microphone]",
        HTMLSelectElement,
      );

      microphoneSelect.dispatchEvent(gesture);
      expect(onMicrophoneRefresh).toHaveBeenCalledOnce();
    }
  });

  it("coalesces picker gestures while media access is starting", () => {
    const onCameraRefresh = vi.fn();
    const { container } = renderConfigView({
      activeSection: "__appearance__",
      includeSections: ["__appearance__"],
      camera: {
        devices: [],
        permissionRequired: true,
        selectedDeviceId: "",
        loading: true,
        error: null,
      },
      onCameraSelect: vi.fn(),
      onCameraRefresh,
    });
    const cameraSelect = queryRequired(container, "[data-settings-camera]", HTMLSelectElement);

    cameraSelect.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 2 }));
    expect(onCameraRefresh).not.toHaveBeenCalled();

    cameraSelect.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    cameraSelect.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    cameraSelect.dispatchEvent(new KeyboardEvent("keydown", { key: "F4", bubbles: true }));
    expect(onCameraRefresh).toHaveBeenCalledOnce();
  });

  it("previews lobster sounds only when the user enables them", () => {
    const param = () => ({
      setValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
    });
    const audioContextCtor = vi.fn(function MockAudioContext() {
      return {
        state: "running",
        currentTime: 0,
        destination: {},
        resume: vi.fn(),
        close: vi.fn(() => Promise.resolve()),
        createOscillator: vi.fn(() => ({
          type: "sine",
          frequency: param(),
          connect: (node: unknown) => node,
          start: vi.fn(),
          stop: vi.fn(),
        })),
        createGain: vi.fn(() => ({ gain: param(), connect: vi.fn() })),
      };
    });
    vi.stubGlobal("AudioContext", audioContextCtor);

    const activateSwitch = (element: HTMLElement & { checked: boolean }, nextChecked: boolean) => {
      const dispatchClick = (path: EventTarget[]) => {
        const event = new MouseEvent("click", { bubbles: true, composed: true });
        Object.defineProperty(event, "composedPath", { value: () => path });
        element.dispatchEvent(event);
      };
      dispatchClick([document.createElement("span"), element]);
      element.checked = nextChecked;
      dispatchClick([document.createElement("input"), element]);
      element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    };

    const setLobsterPetSounds = vi.fn();
    const disabled = renderConfigView({
      activeSection: "__appearance__",
      includeSections: ["__appearance__"],
      lobsterPetVisits: true,
      setLobsterPetVisits: vi.fn(),
      lobsterPetSounds: false,
      setLobsterPetSounds,
    });
    const disabledRow = Array.from(
      disabled.container.querySelectorAll<HTMLElement>(".settings-row--toggle"),
    ).find((candidate) => candidate.textContent?.includes("Lobster sounds"));
    const disabledSwitch = disabledRow?.querySelector<HTMLElement & { checked: boolean }>(
      "wa-switch",
    );
    expect(disabledSwitch).toBeDefined();
    if (!disabledSwitch) {
      return;
    }

    expect(audioContextCtor).not.toHaveBeenCalled();
    activateSwitch(disabledSwitch, true);
    expect(audioContextCtor).toHaveBeenCalledTimes(1);
    expect(setLobsterPetSounds).toHaveBeenCalledWith(true);

    const enabled = renderConfigView({
      activeSection: "__appearance__",
      includeSections: ["__appearance__"],
      lobsterPetVisits: true,
      setLobsterPetVisits: vi.fn(),
      lobsterPetSounds: true,
      setLobsterPetSounds,
    });
    const enabledRow = Array.from(
      enabled.container.querySelectorAll<HTMLElement>(".settings-row--toggle"),
    ).find((candidate) => candidate.textContent?.includes("Lobster sounds"));
    const enabledSwitch = enabledRow?.querySelector<HTMLElement & { checked: boolean }>(
      "wa-switch",
    );
    expect(enabledSwitch).toBeDefined();
    if (!enabledSwitch) {
      return;
    }

    const noOpKey = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      composed: true,
    });
    Object.defineProperty(noOpKey, "composedPath", {
      value: () => [document.createElement("input"), enabledSwitch],
    });
    enabledSwitch.dispatchEvent(noOpKey);
    expect(audioContextCtor).toHaveBeenCalledTimes(1);

    activateSwitch(enabledSwitch, false);
    expect(audioContextCtor).toHaveBeenCalledTimes(1);
    expect(setLobsterPetSounds).toHaveBeenLastCalledWith(false);
  });

  it("renders and changes the live sidebar activity preference", () => {
    const setSidebarLiveActivity = vi.fn();
    const { container } = renderConfigView({
      activeSection: "__appearance__",
      includeSections: ["__appearance__"],
      sidebarLiveActivity: true,
      setSidebarLiveActivity,
    });

    const row = Array.from(container.querySelectorAll<HTMLElement>(".settings-row--toggle")).find(
      (candidate) => candidate.textContent?.includes("Show live agent activity in sidebar"),
    );
    expect(row).toBeDefined();
    expect(row?.querySelector<HTMLElement & { checked: boolean }>("wa-switch")?.checked).toBe(true);
    row?.click();
    expect(setSidebarLiveActivity).toHaveBeenCalledWith(false);
  });

  it("labels hidden session sections from the catalog and keeps ids as the fallback", () => {
    const setSessionCatalogHidden = vi.fn();
    const { container } = renderConfigView({
      activeSection: "__appearance__",
      includeSections: ["__appearance__"],
      hiddenSessionCatalogIds: new Set(["claude", "offline-catalog"]),
      hiddenSessionCatalogLabels: new Map([["claude", "Claude Code"]]),
      setSessionCatalogHidden,
    });

    const heading = Array.from(container.querySelectorAll("h3")).find(
      (candidate) => candidate.textContent?.trim() === "Hidden session sections",
    );
    const labeledRow = Array.from(container.querySelectorAll<HTMLElement>(".settings-row")).find(
      (candidate) =>
        candidate.querySelector(".settings-row__title")?.textContent?.trim() === "Claude Code",
    );
    const fallbackRow = Array.from(container.querySelectorAll<HTMLElement>(".settings-row")).find(
      (candidate) =>
        candidate.querySelector(".settings-row__title")?.textContent?.trim() === "offline-catalog",
    );
    expect(heading).toBeDefined();
    expect(labeledRow).toBeDefined();
    expect(fallbackRow).toBeDefined();
    labeledRow?.querySelector<HTMLButtonElement>("button")?.click();
    expect(setSessionCatalogHidden).toHaveBeenCalledWith("claude", false);
  });

  it("uses rich Lobsterdex lore tooltips and opens the full collection", () => {
    const firstSeenAt = new Date("2026-07-10T12:00:00.000Z").getTime();
    vi.stubGlobal("localStorage", window.localStorage);
    localStorage.setItem(
      "openclaw.control.lobsterdex.v1",
      JSON.stringify({
        crimson: { firstSeenAt, name: "Ruby", shinySeenAt: firstSeenAt },
      }),
    );
    const onOpenLobsterdex = vi.fn();
    try {
      const { container } = renderConfigView({
        activeSection: "__appearance__",
        includeSections: ["__appearance__"],
        lobsterPetVisits: true,
        setLobsterPetVisits: vi.fn(),
        lobsterPetSounds: true,
        setLobsterPetSounds: vi.fn(),
        lobsterdexHref: "/settings/lobsterdex",
        onOpenLobsterdex,
      });

      const seen = container.querySelector(".lobster-pet--palette-crimson");
      const seenTooltip = seen?.closest("openclaw-tooltip");
      expect(seen?.hasAttribute("title")).toBe(false);
      expect(seen?.getAttribute("aria-label")).toContain("Ruby ✦");
      expect(seenTooltip?.querySelector('[slot="content"]')?.textContent).toContain(
        "The classic red, first in every tide pool.",
      );
      expect(seenTooltip?.querySelector('[slot="content"]')?.textContent).toContain(
        new Date(firstSeenAt).toLocaleDateString(),
      );

      const unseen = container.querySelector(".lobster-pet--palette-watermelon");
      expect(unseen?.getAttribute("aria-label")).toContain("Ripe when thumped.");
      expect(
        unseen?.closest("openclaw-tooltip")?.querySelector('[slot="content"]')?.textContent,
      ).toContain("Ripe when thumped.");

      const openLink = container.querySelector<HTMLAnchorElement>(".lobsterdex__open");
      openLink?.addEventListener("click", (event) => event.preventDefault(), {
        capture: true,
        once: true,
      });
      openLink?.click();
      expect(onOpenLobsterdex).not.toHaveBeenCalled();

      openLink?.click();
      expect(onOpenLobsterdex).toHaveBeenCalledOnce();
    } finally {
      localStorage.removeItem("openclaw.control.lobsterdex.v1");
      vi.unstubAllGlobals();
    }
  });

  it("validates and changes the browser-local chat width", () => {
    const setChatMessageMaxWidth = vi.fn();
    const { container } = renderConfigView({
      activeSection: "__appearance__",
      includeSections: ["__appearance__"],
      setChatMessageMaxWidth,
    });
    const input = container.querySelector<HTMLInputElement>("[data-settings-chat-message-width]");
    expect(input).not.toBeNull();

    input!.value = " min(1280px,  82%) ";
    input!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(setChatMessageMaxWidth).toHaveBeenCalledWith("min(1280px, 82%)");

    input!.value = "960px; color: red";
    input!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(input!.validationMessage).not.toBe("");
    expect(setChatMessageMaxWidth).toHaveBeenCalledTimes(1);
  });

  it("marks browser follow-up overrides and resets them to the server", () => {
    const setChatFollowUpMode = vi.fn();
    const resetChatFollowUpMode = vi.fn();
    const { container } = renderConfigView({
      activeSection: "__appearance__",
      includeSections: ["__appearance__"],
      chatFollowUpMode: "queue",
      chatFollowUpModeOverridden: true,
      serverQueueMode: "steer",
      setChatFollowUpMode,
      resetChatFollowUpMode,
    });

    expect(container.textContent).toContain("Overriding server default (steer)");
    const reset = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Reset to server default",
    );
    expect(reset).toBeDefined();
    reset?.click();
    expect(resetChatFollowUpMode).toHaveBeenCalledOnce();
    expect(setChatFollowUpMode).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
