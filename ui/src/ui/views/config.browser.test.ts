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
    let { saveButton, applyButton } = findActionButtons(container);
    expect(saveButton).not.toBeUndefined();
    expect(saveButton?.disabled).toBe(false);
    expect(applyButton?.disabled).toBe(false);

    renderCase({
      schema: null,
      formMode: "form",
      formValue: { gateway: { mode: "local" } },
      originalValue: {},
    });
    ({ saveButton, applyButton } = findActionButtons(container));
    expect(saveButton).not.toBeUndefined();
    expect(saveButton?.disabled).toBe(true);
    expect(applyButton?.disabled).toBe(true);

    renderCase({
      formMode: "raw",
      raw: "{\n}\n",
      originalRaw: "{\n}\n",
    });
    let clearButton: HTMLButtonElement | undefined;
    ({ clearButton, saveButton, applyButton } = findActionButtons(container));
    expect(clearButton).not.toBeUndefined();
    expect(saveButton).not.toBeUndefined();
    expect(applyButton).not.toBeUndefined();
    expect(clearButton?.disabled).toBe(true);
    expect(saveButton?.disabled).toBe(true);
    expect(applyButton?.disabled).toBe(true);

    const onReset = vi.fn();
    renderCase({
      formMode: "raw",
      raw: '{\n  gateway: { mode: "local" }\n}\n',
      originalRaw: "{\n}\n",
      onReset,
    });
    ({ clearButton, saveButton, applyButton } = findActionButtons(container));
    expect(saveButton).not.toBeUndefined();
    expect(applyButton).not.toBeUndefined();
    expect(clearButton?.disabled).toBe(false);
    expect(saveButton?.disabled).toBe(false);
    expect(applyButton?.disabled).toBe(false);

    clearButton?.click();
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
    let busyButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Saving…"),
    );
    let { clearButton, applyButton } = findActionButtons(container);
    expect(busyButton).toBeTruthy();
    expect(busyButton?.disabled).toBe(true);
    expect(busyButton?.getAttribute("aria-busy")).toBe("true");
    expect(busyButton?.querySelector(".config-action-spinner")).not.toBeNull();
    expect(clearButton?.disabled).toBe(false);
    expect(applyButton?.disabled).toBe(false);

    renderCase({ applying: true });
    busyButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Applying…"),
    );
    ({ clearButton } = findActionButtons(container));
    expect(busyButton).toBeTruthy();
    expect(busyButton?.disabled).toBe(true);
    expect(busyButton?.querySelector(".config-action-spinner")).not.toBeNull();
    expect(clearButton?.disabled).toBe(false);

    renderCase({ updating: true });
    busyButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Updating…"),
    );
    ({ clearButton } = findActionButtons(container));
    expect(busyButton).toBeTruthy();
    expect(busyButton?.disabled).toBe(true);
    expect(busyButton?.querySelector(".config-action-spinner")).not.toBeNull();
    expect(clearButton?.disabled).toBe(false);
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

    const btn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Raw",
    );
    expect(btn).toBeTruthy();
    btn?.click();
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

    const formButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "Form",
    );
    const rawButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "Raw",
    );
    expect(formButton?.classList.contains("active")).toBe(true);
    expect(rawButton?.disabled).toBe(true);
    const rawNotice = container.querySelector(".config-actions__notice");
    const actionButtons = container.querySelector(".config-actions__buttons");
    expect(rawNotice).not.toBeNull();
    expect(actionButtons).not.toBeNull();
    expect(actionButtons?.textContent).toContain("Reload");
    expect(actionButtons?.textContent).toContain("Update");
    expect(normalizedText(container)).toContain(
      "Raw mode disabled (snapshot cannot safely round-trip raw text).",
    );
    expect(container.querySelector(".config-raw-field")).toBeNull();

    rawButton?.click();
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
    expect(tabs).toContain("Settings");
    expect(tabs).toContain("Agents");
    expect(tabs).toContain("Gateway");

    const btn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Gateway",
    );
    expect(btn).toBeTruthy();
    btn?.click();
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

    const content = container.querySelector<HTMLElement>(".config-content");
    expect(content).toBeTruthy();
    if (!content) {
      return;
    }
    content.scrollTop = 280;
    content.scrollLeft = 24;
    content.scrollTo = vi.fn(({ top, left }: { top?: number; left?: number }) => {
      content.scrollTop = top ?? content.scrollTop;
      content.scrollLeft = left ?? content.scrollLeft;
    }) as typeof content.scrollTo;

    const messagesButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "Messages",
    );
    expect(messagesButton).toBeTruthy();

    messagesButton?.click();
    await Promise.resolve();

    expect(content.scrollTo).toHaveBeenCalledOnce();
    expect(content.scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: "auto" });
    expect(content.scrollTop).toBe(0);
    expect(content.scrollLeft).toBe(0);
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

    const icon = container.querySelector<SVGElement>(".config-search__icon");
    expect(icon).not.toBeNull();
    expect(icon?.closest(".config-search__input-row")).not.toBeNull();

    const input = container.querySelector(".config-search__input");
    expect(input).not.toBeNull();
    if (!input) {
      return;
    }
    (input as HTMLInputElement).value = "gateway";
    input.dispatchEvent(new Event("input", { bubbles: true }));
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

    expect(container.querySelectorAll(".config-section-card__header").length).toBeGreaterThan(0);
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
    expect(clearButton).toBeTruthy();
    clearButton?.click();
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

    const text = normalizedText(container);
    expect(text).toContain("1 secret redacted");
    expect(text).toContain("Use the reveal button above to edit the raw config.");
    expect(text).not.toContain("supersecret");
    expect(container.querySelector("textarea")).toBeNull();

    const revealButton = container.querySelector<HTMLButtonElement>(".config-raw-toggle");
    expect(revealButton).toBeTruthy();
    revealButton?.click();

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).not.toBeNull();
    expect(textarea?.value).toContain("supersecret");
    if (!textarea) {
      return;
    }
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

    expect(normalizedText(container)).toContain("View pending changes");
    expect(normalizedText(container)).not.toContain("gateway.mode");

    const details = container.querySelector<HTMLDetailsElement>(".config-diff");
    expect(details).not.toBeNull();
    details!.open = true;
    details!.dispatchEvent(new Event("toggle"));

    const text = normalizedText(container);
    expect(updateCount).toBe(1);
    expect(onRawChange).not.toHaveBeenCalled();
    expect(text).toContain("gateway.mode");
    expect(text).toContain('"local"');
    expect(text).toContain('"remote"');
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

    const text = normalizedText(container);
    expect(text).toContain("View 1 pending change");
    expect(text).toContain("items");
    expect(text).toContain("[0 items]");
    expect(text).toContain("[1 item]");
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

    const details = container.querySelector<HTMLDetailsElement>(".config-diff");
    expect(details).not.toBeNull();
    details!.open = true;
    details!.dispatchEvent(new Event("toggle"));

    const text = normalizedText(container);
    expect(text).toContain("channels.discord.token.id");
    expect(text).toContain("[redacted - click reveal to view]");
    expect(text).not.toContain("TOKEN_BEFORE");
    expect(text).not.toContain("TOKEN_AFTER");

    const revealButton = container.querySelector<HTMLButtonElement>(".config-raw-toggle");
    expect(revealButton).not.toBeNull();
    revealButton!.click();

    const revealedText = normalizedText(container);
    expect(revealedText).toContain("TOKEN_BEFORE");
    expect(revealedText).toContain("TOKEN_AFTER");
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

    const details = container.querySelector<HTMLDetailsElement>(".config-diff");
    expect(details).not.toBeNull();
    details!.open = true;
    details!.dispatchEvent(new Event("toggle"));
    const revealButton = container.querySelector<HTMLButtonElement>(".config-raw-toggle");
    expect(revealButton).not.toBeNull();
    revealButton!.click();
    expect(normalizedText(container)).toContain("TOKEN_A_AFTER");

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

    const text = normalizedText(container);
    expect(text).toContain("1 secret redacted");
    expect(text).not.toContain("TOKEN_A_AFTER");
    expect(text).not.toContain("TOKEN_B_AFTER");
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector<HTMLDetailsElement>(".config-diff")?.open).toBe(false);
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

    const details = container.querySelector<HTMLDetailsElement>(".config-diff");
    expect(details).not.toBeNull();
    details!.open = true;
    details!.dispatchEvent(new Event("toggle"));

    const text = normalizedText(container);
    expect(text).toContain("integrations.foo.bar.credential");
    expect(text).toContain("[redacted - click reveal to view]");
    expect(text).not.toContain("TOKEN_BEFORE");
    expect(text).not.toContain("TOKEN_AFTER");
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

    const details = container.querySelector<HTMLDetailsElement>(".config-diff");
    expect(details).not.toBeNull();
    details!.open = true;
    details!.dispatchEvent(new Event("toggle"));
    expect(normalizedText(container)).toContain("gateway.mode");

    props.raw = props.originalRaw;
    props.formValue = props.originalValue;
    rerender();

    expect(container.querySelector(".config-diff")).toBeNull();
    expect(normalizedText(container)).toContain("No changes");
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

    const input = container.querySelector<HTMLInputElement>(".cfg-input");
    expect(input).not.toBeNull();
    expect(input?.readOnly).toBe(true);
    expect(input?.value).toBe("");
    expect(input?.placeholder).toContain("Structured value (SecretRef)");
    expect(container.textContent ?? "").not.toContain("[object Object]");

    if (!input) {
      return;
    }
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

    const rawUnavailableInput = container.querySelector<HTMLInputElement>(".cfg-input");
    expect(rawUnavailableInput).not.toBeNull();
    expect(rawUnavailableInput?.placeholder).toBe(
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
    expect(input).not.toBeNull();
    expect(input?.readOnly).toBe(false);
    expect(input?.value).toContain("malformed");
    expect(input?.value).not.toBe("[object Object]");
    expect(input?.placeholder).not.toContain("Structured value (SecretRef)");

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

    const customButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "Import",
    );

    expect(customButton?.disabled).toBe(false);
    expect(normalizedText(container)).toContain(
      "Click Import to add one browser-local tweakcn theme",
    );

    customButton?.click();

    expect(onOpenCustomThemeImport).toHaveBeenCalledTimes(1);
  });

  it("shows the tweakcn importer once the custom slot is opened", () => {
    const { container } = renderConfigView({
      activeSection: "__appearance__",
      includeSections: ["__appearance__"],
      customThemeImportExpanded: true,
      customThemeImportFocusToken: 1,
    });

    const importButton = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Import theme"),
    );

    expect(importButton?.disabled).toBe(true);
    expect(container.querySelector(".settings-theme-import__input")).not.toBeNull();
    expect(
      container.querySelector<HTMLAnchorElement>(".settings-theme-import__external")?.href,
    ).toBe("https://tweakcn.com/editor/theme");
    expect(normalizedText(container)).toContain("Share links, editor URLs, registry URLs");
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

    const customButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "Light Green",
    );
    expect(customButton?.disabled).toBe(false);
    customButton?.click();
    expect(setTheme).toHaveBeenCalledWith("custom", expect.any(Object));

    const replaceButton = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Replace Light Green"),
    );
    const clearButton = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Clear Light Green"),
    );
    replaceButton?.click();
    clearButton?.click();

    expect(onImportCustomTheme).toHaveBeenCalledTimes(1);
    expect(onClearCustomTheme).toHaveBeenCalledTimes(1);
    expect(normalizedText(container)).toContain("Loaded Light Green");

    const input = container.querySelector(".settings-theme-import__input") as HTMLInputElement;
    input.value = "/r/themes/cmlhfpjhw000004l4f4ax3m7z";
    input.dispatchEvent(new Event("input"));
    expect(onCustomThemeImportUrlChange).toHaveBeenCalledWith(
      "/r/themes/cmlhfpjhw000004l4f4ax3m7z",
    );
  });
});
