// Control UI tests cover config behavior.
import { render } from "lit";
import { beforeAll, describe, expect, it, vi } from "vitest";
import "../../styles.css";
import type { ThemeMode, ThemeName } from "../../app/theme.ts";
import { warmJson5 } from "../../lib/json5-runtime.ts";
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
    autoSaveStatus: "idle" as const,
    needsApply: false,
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
    onSectionChange: vi.fn(),
    onSave: vi.fn(),
    onApply: vi.fn(),
    onRawDiscard: vi.fn(),
    onSubsectionChange: vi.fn(),
    version: "2026.3.11",
    theme: "claw" as ThemeName,
    themeMode: "system" as ThemeMode,
    setTheme: vi.fn(),
    setThemeMode: vi.fn(),
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
    setTextScale: vi.fn(),
    chatSendShortcut: "enter" as const,
    setChatSendShortcut: vi.fn(),
    chatFollowUpMode: undefined,
    serverQueueMode: "steer" as const,
    setChatFollowUpMode: vi.fn(),
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
      formValue: { gateway: { mode: "remote" } },
      originalValue: { gateway: { mode: "local" } },
    });

    expect(container.querySelector(".config-actions")).toBeNull();
    expect(container.querySelector(".config-layout")).toBeNull();
    expect(container.querySelector(".config-search__input")).toBeNull();
    for (const label of ["Reload", "Clear", "Save", "Apply", "Update"]) {
      expect(findOptionalButtonByText(container, label)).toBeUndefined();
    }
    // Idle autosave renders no status row beyond the mode toggle.
    expect(container.querySelector(".config-toolbar__status .settings-status")).toBeNull();
  });

  it("renders the inline autosave status and retries failed saves", () => {
    const onSave = vi.fn();
    const { container } = renderConfigView({ autoSaveStatus: "saving", onSave });
    const status = queryRequired(container, ".config-toolbar__status", HTMLElement);
    expect(status.textContent?.trim()).toBe("Saving…");
    expect(
      status.querySelector(".settings-status")?.classList.contains("settings-status--accent"),
    ).toBe(true);

    const saved = renderConfigView({ autoSaveStatus: "saved" });
    expect([
      ...queryRequired(saved.container, ".config-toolbar__status .settings-status", HTMLElement)
        .classList,
    ]).toContain("settings-status--ok");
    expect(saved.container.textContent).toContain("Saved");

    const failed = renderConfigView({ autoSaveStatus: "error", onSave });
    const failedStatus = queryRequired(failed.container, ".config-toolbar__status", HTMLElement);
    expect(failedStatus.textContent).toContain("Save failed");
    expect(
      failedStatus.querySelector(".settings-status")?.classList.contains("settings-status--danger"),
    ).toBe(true);
    findButtonByText(failed.container, "Retry").click();
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("offers only a reload on base-hash conflicts instead of a retry", () => {
    const onSave = vi.fn();
    const onRawDiscard = vi.fn();
    const { container } = renderConfigView({ autoSaveStatus: "conflict", onSave, onRawDiscard });

    const status = queryRequired(container, ".config-toolbar__status", HTMLElement);
    expect(status.textContent).toContain("Settings changed elsewhere");
    expect(
      status.querySelector(".settings-status")?.classList.contains("settings-status--danger"),
    ).toBe(true);
    expect(findOptionalButtonByText(container, "Retry")).toBeUndefined();
    findButtonByText(container, "Reload").click();
    expect(onRawDiscard).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("shows the restart banner after a save and wires it to apply", () => {
    const onApply = vi.fn();
    const { container } = renderConfigView({ needsApply: true, onApply });

    const banner = queryRequired(container, ".config-apply-banner", HTMLElement);
    expect(banner.textContent).toContain("Saved to openclaw.json — restart the gateway to apply.");
    const applyButton = findButtonByText(container, "Restart & apply");
    expect(applyButton.disabled).toBe(false);
    applyButton.click();
    expect(onApply).toHaveBeenCalledTimes(1);

    const busy = renderConfigView({ needsApply: true, applying: true, onApply });
    const busyButton = findButtonContainingText(busy.container, "Applying…");
    expect(busyButton.disabled).toBe(true);
    expect(busyButton.getAttribute("aria-busy")).toBe("true");
    expect(busyButton.querySelectorAll(".config-action-spinner")).toHaveLength(1);

    // Any in-flight write, pending load, or dirty raw draft gates the action.
    for (const overrides of [
      { saving: true },
      { loading: true },
      { updating: true },
      { autoSaveStatus: "saving" as const },
      { formMode: "raw" as const, raw: '{\n  "a": 1\n}\n', originalRaw: "{\n}\n" },
    ]) {
      const gated = renderConfigView({ needsApply: true, ...overrides });
      expect(findButtonByText(gated.container, "Restart & apply").disabled).toBe(true);
    }

    const cleared = renderConfigView({ needsApply: false });
    expect(cleared.container.querySelector(".config-apply-banner")).toBeNull();
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
      needsApply: true,
    });

    // The capability refuses form submissions and apply until the raw draft
    // is saved or discarded — so the raw actions must stay on screen and the
    // Form toggle + restart action are gated instead of failing generically.
    expect(container.querySelector(".config-raw-actions")).not.toBeNull();
    expect(findButtonByText(container, "Form").disabled).toBe(true);
    expect(findButtonByText(container, "Restart & apply").disabled).toBe(true);
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
      "Your config contains fields the form editor can't safely represent. Use Raw mode to edit those entries.",
    );

    render(renderConfig({ ...props, formMode: "raw" }), container);
    expect(normalizedText(container)).not.toContain(
      "Your config contains fields the form editor can't safely represent. Use Raw mode to edit those entries.",
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

  it("renders the virtual Notifications tab in Communication settings", () => {
    const onSectionChange = vi.fn();
    const { container } = renderConfigView({
      navRootLabel: "Communication",
      includeSections: ["channels", "messages", "broadcast", "__notifications__", "talk", "audio"],
      includeVirtualSections: true,
      onSectionChange,
      schema: {
        type: "object",
        properties: {
          channels: { type: "object", properties: {} },
          messages: { type: "object", properties: {} },
        },
      },
      formValue: { channels: {}, messages: {} },
      originalValue: { channels: {}, messages: {} },
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
      includeSections: ["channels", "messages", "__notifications__"],
      includeVirtualSections: true,
      onWebPushSubscribe,
      schema: {
        type: "object",
        properties: {
          channels: { type: "object", properties: {} },
          messages: { type: "object", properties: {} },
        },
      },
      webPush: {
        supported: true,
        permission: "default",
        subscribed: false,
        loading: false,
      },
    });

    const card = queryRequired(container, "#settings-communications-notifications", HTMLElement);
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
              authPermanentBackoffMinutes: {
                type: "number",
              },
            },
          },
        },
      },
      formValue: {
        auth: {
          authPermanentBackoffMinutes: 10,
        },
      },
      originalValue: {
        auth: {
          authPermanentBackoffMinutes: 10,
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
        "channels.discord.token": { sensitive: true },
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
        "channels.discord.token": { sensitive: true },
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
          "channels.discord.token": { sensitive: true },
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
    const { container } = renderConfigView({
      activeSection: "__appearance__",
      includeSections: ["__appearance__"],
      microphone: {
        devices: [{ deviceId: "mic-1", label: "Desk Mic" }],
        selectedDeviceId: "mic-1",
        loading: false,
        error: null,
      },
      onMicrophoneSelect: vi.fn(),
      onMicrophoneRefresh: vi.fn(),
      camera: {
        devices: [{ deviceId: "camera-1", label: "Desk Camera" }],
        selectedDeviceId: "camera-1",
        loading: false,
        error: null,
      },
      onCameraSelect: vi.fn(),
      onCameraRefresh: vi.fn(),
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
    const cameraSelect = queryRequired(container, "[data-settings-camera]", HTMLSelectElement);
    expect(cameraSelect.getAttribute("aria-label")).toBe("Camera");
    expect(Array.from(cameraSelect.options, (option) => option.textContent?.trim())).toEqual([
      "System default",
      "Desk Camera",
    ]);
  });

  it("marks browser follow-up overrides and resets them to the server", () => {
    const setChatFollowUpMode = vi.fn();
    const { container } = renderConfigView({
      activeSection: "__appearance__",
      includeSections: ["__appearance__"],
      chatFollowUpMode: "queue",
      serverQueueMode: "steer",
      setChatFollowUpMode,
    });

    expect(container.textContent).toContain("Overriding server default (steer)");
    const reset = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Reset to server default",
    );
    expect(reset).toBeDefined();
    reset?.click();
    expect(setChatFollowUpMode).toHaveBeenCalledWith(undefined);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
