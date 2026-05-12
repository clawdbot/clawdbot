import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThemeMode, ThemeName } from "../theme.ts";
import { renderConfig, resetConfigViewStateForTests, type ConfigProps } from "./config.ts";

describe("config view", () => {
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
    showModeToggle: true,
    formValue: {},
    originalValue: {},
    searchQuery: "",
    activeSection: null,
    activeSubsection: null,
    onRawChange: vi.fn(),
    onFormModeChange: vi.fn(),
    onFormPatch: vi.fn(),
    onSearchChange: vi.fn(),
    onSectionChange: vi.fn(),
    onReload: vi.fn(),
    onReset: vi.fn(),
    onSave: vi.fn(),
    onApply: vi.fn(),
    onUpdate: vi.fn(),
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
    borderRadius: 50,
    setBorderRadius: vi.fn(),
    gatewayUrl: "",
    assistantName: "OpenClaw",
  });

  function findActionButtons(container: HTMLElement): {
    clearButton?: HTMLButtonElement;
    saveButton?: HTMLButtonElement;
    applyButton?: HTMLButtonElement;
    updateButton?: HTMLButtonElement;
  } {
    const buttons = Array.from(container.querySelectorAll("button"));
    return {
      clearButton: buttons.find((btn) => btn.textContent?.trim() === "Clear"),
      saveButton: buttons.find((btn) => btn.textContent?.trim() === "Save"),
      applyButton: buttons.find((btn) => btn.textContent?.trim() === "Apply"),
      updateButton: buttons.find((btn) => btn.textContent?.trim() === "Update"),
    };
  }

  function requireActionButton(
    button: HTMLButtonElement | undefined,
    text: string,
  ): HTMLButtonElement {
    expect(button).toBeInstanceOf(HTMLButtonElement);
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`Expected ${text} action button`);
    }
    return button;
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
          onRequestUpdate: rerender,
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

  beforeEach(() => {
    resetConfigViewStateForTests();
  });

  it("updates save/apply disabled state from form safety and raw dirtiness", () => {
    const container = document.createElement("div");

    const renderCase = (overrides: Partial<ConfigProps>) =>
      render(renderConfig({ ...baseProps(), ...overrides }), container);

    renderCase({
      schema: {
        type: "object",
        properties: {
          mixed: {
            anyOf: [{ type: "string" }, { type: "object", properties: {} }],
          },
        },
      },
      schemaLoading: false,
      uiHints: {},
      formMode: "form",
      formValue: { mixed: "x" },
    });
    let actionButtons = findActionButtons(container);
    let saveButton = requireActionButton(actionButtons.saveButton, "Save");
    let applyButton = requireActionButton(actionButtons.applyButton, "Apply");
    expect(saveButton.disabled).toBe(false);
    expect(applyButton.disabled).toBe(false);

    renderCase({
      schema: null,
      formMode: "form",
      formValue: { gateway: { mode: "local" } },
      originalValue: {},
    });
    actionButtons = findActionButtons(container);
    saveButton = requireActionButton(actionButtons.saveButton, "Save");
    applyButton = requireActionButton(actionButtons.applyButton, "Apply");
    expect(saveButton.disabled).toBe(true);
    expect(applyButton.disabled).toBe(true);

    renderCase({
      formMode: "raw",
      raw: "{\n}\n",
      originalRaw: "{\n}\n",
    });
    actionButtons = findActionButtons(container);
    let clearButton = requireActionButton(actionButtons.clearButton, "Clear");
    saveButton = requireActionButton(actionButtons.saveButton, "Save");
    applyButton = requireActionButton(actionButtons.applyButton, "Apply");
    expect(clearButton.disabled).toBe(true);
    expect(saveButton.disabled).toBe(true);
    expect(applyButton.disabled).toBe(true);

    const onReset = vi.fn();
    renderCase({
      formMode: "raw",
      raw: '{\n  gateway: { mode: "local" }\n}\n',
      originalRaw: "{\n}\n",
      onReset,
    });
    actionButtons = findActionButtons(container);
    clearButton = requireActionButton(actionButtons.clearButton, "Clear");
    saveButton = requireActionButton(actionButtons.saveButton, "Save");
    applyButton = requireActionButton(actionButtons.applyButton, "Apply");
    expect(clearButton.disabled).toBe(false);
    expect(saveButton.disabled).toBe(false);
    expect(applyButton.disabled).toBe(false);

    clearButton.click();
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("renders inline progress inside busy action buttons without locking adjacent controls", () => {
    const container = document.createElement("div");
    const renderCase = (overrides: Partial<ConfigProps>) =>
      render(
        renderConfig({
          ...baseProps(),
          schema: {
            type: "object",
            properties: {
              gateway: { type: "object", properties: { mode: { type: "string" } } },
            },
          },
          formValue: { gateway: { mode: "remote" } },
          originalValue: { gateway: { mode: "local" } },
          ...overrides,
        }),
        container,
      );

    renderCase({ saving: true });
    let busyButton = findButtonContainingText(container, "Saving…");
    let actionButtons = findActionButtons(container);
    let clearButton = requireActionButton(actionButtons.clearButton, "Clear");
    let applyButton = requireActionButton(actionButtons.applyButton, "Apply");
    expect(busyButton.disabled).toBe(true);
    expect(busyButton.getAttribute("aria-busy")).toBe("true");
    expect(busyButton.querySelectorAll(".config-action-spinner")).toHaveLength(1);
    expect(clearButton.disabled).toBe(false);
    expect(applyButton.disabled).toBe(false);

    renderCase({ applying: true });
    busyButton = findButtonContainingText(container, "Applying…");
    actionButtons = findActionButtons(container);
    clearButton = requireActionButton(actionButtons.clearButton, "Clear");
    expect(busyButton.disabled).toBe(true);
    expect(busyButton.querySelectorAll(".config-action-spinner")).toHaveLength(1);
    expect(clearButton.disabled).toBe(false);

    renderCase({ updating: true });
    busyButton = findButtonContainingText(container, "Updating…");
    actionButtons = findActionButtons(container);
    clearButton = requireActionButton(actionButtons.clearButton, "Clear");
    expect(busyButton.disabled).toBe(true);
    expect(busyButton.querySelectorAll(".config-action-spinner")).toHaveLength(1);
    expect(clearButton.disabled).toBe(false);
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
    expect(
      queryRequired(container, ".config-actions__notice", HTMLElement).textContent?.trim(),
    ).toBe("Raw mode disabled (snapshot cannot safely round-trip raw text).");
    const actionButtons = queryRequired(container, ".config-actions__buttons", HTMLElement);
    expect(
      [...actionButtons.querySelectorAll("button")].map((button) => button.textContent?.trim()),
    ).toEqual(["Reload", "Clear", "Save", "Apply", "Update"]);
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

    const tabs = Array.from(container.querySelectorAll(".config-top-tabs__tab")).map((tab) =>
      tab.textContent?.trim(),
    );
    expect(tabs).toEqual(["Settings", "Agents", "Gateway", "Theme"]);

    const btn = findButtonByText(container, "Gateway");
    btn.click();
    expect(onSectionChange).toHaveBeenCalledWith("gateway");
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

    const messagesButton = findButtonByText(container, "Messages");

    messagesButton.click();
    await Promise.resolve();

    expect(content.scrollTo).toHaveBeenCalledOnce();
    expect(content.scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: "auto" });
    expect(content.scrollTop).toBe(0);
    expect(content.scrollLeft).toBe(0);
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
      Array.from(container.querySelectorAll(".cfg-field__label")).map((label) =>
        label.textContent?.trim(),
      ),
    ).toEqual(["Telegram"]);
  });

  it("renders and wires the search field controls", () => {
    const container = document.createElement("div");
    const onSearchChange = vi.fn();
    render(
      renderConfig({
        ...baseProps(),
        searchQuery: "gateway",
        onSearchChange,
      }),
      container,
    );

    const icon = queryRequired(container, ".config-search__icon", SVGElement);
    expect(icon.closest(".config-search__input-row")).toBeInstanceOf(HTMLElement);

    const input = container.querySelector(".config-search__input");
    expect(input).toBeInstanceOf(HTMLInputElement);
    const searchInput = input as HTMLInputElement;
    searchInput.value = "gateway";
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onSearchChange).toHaveBeenCalledWith("gateway");
  });

  it("shows section hero and hides nested card header in single-section form view", () => {
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

    const heroTitle = container.querySelector(".config-section-hero__title");
    expect(heroTitle?.textContent?.trim()).toBe("Authentication");
    expect(container.querySelector(".config-section-card__header")).toBeNull();
  });

  it("keeps card headers in multi-section root view", () => {
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
      [...container.querySelectorAll(".config-section-card__title")].map((title) =>
        title.textContent?.trim(),
      ),
    ).toEqual(["Authentication", "Gateway"]);
  });

  it("clears the active search query", () => {
    const container = document.createElement("div");
    const onSearchChange = vi.fn();
    render(
      renderConfig({
        ...baseProps(),
        searchQuery: "gateway",
        onSearchChange,
      }),
      container,
    );
    const clearButton = container.querySelector<HTMLButtonElement>(".config-search__clear");
    if (!clearButton) {
      throw new Error("Expected config search clear button");
    }
    clearButton.click();
    expect(onSearchChange).toHaveBeenCalledWith("");
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
      queryRequired(container, ".config-raw-field .pill", HTMLElement)
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
    expect(revealButton.getAttribute("title")).toBe("Reveal sensitive values");
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
          onRequestUpdate: () => {
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

  it("renders array diff summaries without serializing array values", () => {
    const poison = {
      value: "TOKEN_AFTER",
      toJSON: () => {
        throw new Error("array value should not be serialized");
      },
    };
    const { container } = renderConfigView({
      formValue: {
        items: [poison],
      },
      originalValue: {
        items: [],
      },
    });

    const details = queryRequired(container, ".config-diff", HTMLDetailsElement);
    expect(details.querySelector(".config-diff__summary span")?.textContent?.trim()).toBe(
      "View 1 pending change",
    );
    const item = queryRequired(container, ".config-diff__item", HTMLElement);
    expect(item.querySelector(".config-diff__path")?.textContent?.trim()).toBe("items");
    expect(item.querySelector(".config-diff__from")?.textContent?.trim()).toBe("[0 items]");
    expect(item.querySelector(".config-diff__to")?.textContent?.trim()).toBe("[1 item]");
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
          onRequestUpdate: rerender,
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
          onRequestUpdate: rerender,
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
      queryRequired(container, ".config-raw-field .pill", HTMLElement)
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
          onRequestUpdate: rerender,
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
          onRequestUpdate: rerender,
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
    expect(container.querySelector(".config-status")?.textContent?.trim()).toBe("No changes");
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

    const input = queryRequired(container, ".cfg-input", HTMLInputElement);
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

    const rawUnavailableInput = queryRequired(container, ".cfg-input", HTMLInputElement);
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

    const input = container.querySelector<HTMLInputElement>(".cfg-input");
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
});
