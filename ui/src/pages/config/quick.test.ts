/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderQuickSettings, type QuickSettingsProps } from "./quick.ts";

function expectButtonByText(container: Element, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected button labelled ${text}`);
  }
  return button;
}

function expectRowByLabel(container: Element, text: string): HTMLElement {
  const row = Array.from(container.querySelectorAll<HTMLElement>(".qs-row")).find(
    (candidate) => candidate.querySelector(".qs-row__label")?.textContent?.trim() === text,
  );
  if (!(row instanceof HTMLElement)) {
    throw new Error(`Expected quick settings row "${text}"`);
  }
  return row;
}

function expectFileInput(input: Element | null | undefined): HTMLInputElement {
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("Expected file input");
  }
  return input;
}

function expectStatByLabel(container: Element, text: string): HTMLElement {
  const stat = Array.from(container.querySelectorAll<HTMLElement>(".qs-stat")).find(
    (candidate) => candidate.querySelector(".qs-stat__label")?.textContent?.trim() === text,
  );
  if (!(stat instanceof HTMLElement)) {
    throw new Error(`Expected system stat "${text}"`);
  }
  return stat;
}

function createProps(overrides: Partial<QuickSettingsProps> = {}): QuickSettingsProps {
  return {
    locale: "en",
    onLocaleChange: vi.fn(),
    lobsterPetVisits: true,
    setLobsterPetVisits: () => {},
    lobsterPetSounds: false,
    setLobsterPetSounds: () => {},
    currentModel: "gpt-5.5",
    thinkingLevel: "off",
    fastMode: false,
    onModelChange: vi.fn(),
    onThinkingChange: vi.fn(),
    onFastModeChange: vi.fn(),
    channels: [],
    onChannelConfigure: vi.fn(),
    automation: {
      cronJobCount: 0,
      skillCount: 0,
      mcpServerCount: 0,
    },
    onManageCron: vi.fn(),
    onBrowseSkills: vi.fn(),
    onConfigureMcp: vi.fn(),
    security: {
      gatewayAuth: "Unknown",
      execPolicy: "Allowlist",
      deviceAuth: true,
      browserEnabled: true,
      toolProfile: "coding",
    },
    onSecurityConfigure: vi.fn(),
    canPairDevice: true,
    onPairMobile: vi.fn(),
    onBrowserEnabledToggle: vi.fn(),
    onToolProfileChange: vi.fn(),
    theme: "claw",
    themeMode: "system",
    hasCustomTheme: false,
    customThemeLabel: null,
    textScale: 100,
    setTheme: vi.fn(),
    onOpenCustomThemeImport: vi.fn(),
    setThemeMode: vi.fn(),
    setTextScale: vi.fn(),
    userAvatar: null,
    onUserAvatarChange: vi.fn(),
    connected: true,
    gatewayUrl: "ws://localhost:18789",
    assistantName: "OpenClaw",
    assistantAvatar: null,
    assistantAvatarUrl: null,
    assistantAvatarSource: null,
    assistantAvatarStatus: null,
    assistantAvatarReason: null,
    assistantAvatarOverride: null,
    assistantAvatarUploadBusy: false,
    assistantAvatarUploadError: null,
    onAssistantAvatarOverrideChange: vi.fn(),
    onAssistantAvatarClearOverride: vi.fn(),
    basePath: "",
    version: "2026.4.22",
    ...overrides,
  };
}

function collectQuickSettingsCardKinds(container: Element): string[] {
  const kinds: string[] = [];
  for (const card of container.querySelectorAll(".qs-card")) {
    const kind = Array.from(card.classList).find(
      (className) => className.startsWith("qs-card--") && className !== "qs-card--span-all",
    );
    if (kind) {
      kinds.push(kind);
    }
  }
  return kinds;
}

function expectAssistantAvatarSource(container: Element): { label: string; source: string } {
  const source = container.querySelector(".qs-identity-card--assistant .qs-identity-card__source");
  return {
    label: source?.querySelector("span")?.textContent?.trim() ?? "",
    source: source?.querySelector("code")?.textContent?.trim() ?? "",
  };
}

describe("renderQuickSettings", () => {
  it("uses direct dashboard cards for the compact settings layout", () => {
    const container = document.createElement("div");

    render(renderQuickSettings(createProps()), container);

    expect(collectQuickSettingsCardKinds(container)).toEqual([
      "qs-card--general",
      "qs-card--model",
      "qs-card--channels",
      "qs-card--security",
      "qs-card--system",
      "qs-card--appearance",
      "qs-card--personal",
      "qs-card--automations",
    ]);
    expect(container.querySelectorAll(".qs-card--span-all")).toHaveLength(0);
  });

  it("changes the Control UI language from General settings", () => {
    const onLocaleChange = vi.fn();
    const container = document.createElement("div");

    render(renderQuickSettings(createProps({ locale: "pt-BR", onLocaleChange })), container);

    const row = expectRowByLabel(container, "Language");
    const select = row.querySelector("select");
    expect(select?.value).toBe("pt-BR");
    if (!(select instanceof HTMLSelectElement)) {
      throw new Error("Expected language selector");
    }
    select.value = "en";
    select.dispatchEvent(new Event("change"));
    expect(onLocaleChange).toHaveBeenCalledWith("en");
  });

  it("renders Gateway host identity and resources", () => {
    const container = document.createElement("div");

    render(
      renderQuickSettings(
        createProps({
          systemInfo: {
            machineName: "Gateway Mac",
            hostname: "gateway.local",
            platform: "darwin",
            release: "25.5.0",
            arch: "arm64",
            osLabel: "macOS 26.5.0",
            lanAddress: "192.168.1.20",
            port: 18789,
            nodeVersion: "v24.1.0",
            pid: 1234,
            uptimeMs: 3_600_000,
            cpuCount: 10,
            cpuModel: "Apple M4",
            loadAverage: [1.2, 1.1, 0.9],
            memoryTotalBytes: 34_359_738_368,
            memoryFreeBytes: 17_179_869_184,
            diskTotalBytes: 994_662_584_320,
            diskAvailableBytes: 497_331_292_160,
            diskPath: "/Users/operator/.openclaw",
          },
        }),
      ),
      container,
    );

    const name = container.querySelector(".qs-system__name");
    expect(name?.textContent?.trim()).toBe("Gateway Mac");
    expect(name?.getAttribute("title")).toBe("gateway.local");
    expect(container.querySelector(".qs-system__address")?.textContent?.trim()).toBe(
      "192.168.1.20:18789",
    );
    const metas = Array.from(container.querySelectorAll(".qs-system__meta")).map((node) =>
      node.textContent?.trim(),
    );
    expect(metas).toEqual(["macOS 26.5.0 · arm64", "Node v24.1.0 · PID 1234"]);
    expect(
      container.querySelector(".qs-card--system .qs-card__header .qs-badge")?.textContent?.trim(),
    ).toBe("Up 1h");

    const cpu = expectStatByLabel(container, "CPU");
    expect(cpu.querySelector(".qs-stat__value")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "1.2 load",
    );
    expect(cpu.querySelector(".qs-stat__detail")?.textContent?.trim()).toBe("10 cores");
    expect(cpu.getAttribute("title")).toBe("Apple M4 · Load average: 1.2 · 1.1 · 0.9");
    expect(cpu.querySelector(".qs-meter")?.getAttribute("aria-valuenow")).toBe("12");

    const memory = expectStatByLabel(container, "Memory");
    expect(memory.querySelector(".qs-stat__value")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "50% used",
    );
    expect(memory.querySelector(".qs-stat__detail")?.textContent?.trim()).toBe(
      "16 GB free of 32 GB",
    );

    const disk = expectStatByLabel(container, "Disk");
    expect(disk.querySelector(".qs-stat__value")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "50% used",
    );
    expect(disk.querySelector(".qs-stat__detail")?.textContent?.trim()).toBe(
      "463 GB free of 926 GB",
    );
    expect(disk.getAttribute("title")).toBe("/Users/operator/.openclaw");
    for (const fill of container.querySelectorAll(".qs-meter__fill")) {
      expect([...fill.classList]).toContain("qs-meter__fill--ok");
    }
  });

  it("escalates meter tones as resources run hot", () => {
    const container = document.createElement("div");

    render(
      renderQuickSettings(
        createProps({
          systemInfo: {
            machineName: "Gateway Mac",
            hostname: "gateway.local",
            platform: "darwin",
            release: "25.5.0",
            arch: "arm64",
            osLabel: "macOS 26.5.0",
            nodeVersion: "v24.1.0",
            pid: 1234,
            uptimeMs: 60_000,
            cpuCount: 10,
            loadAverage: [9.8, 9.1, 8.4],
            memoryTotalBytes: 34_359_738_368,
            memoryFreeBytes: 2_147_483_648,
            diskTotalBytes: 994_662_584_320,
            diskAvailableBytes: 198_932_516_864,
          },
        }),
      ),
      container,
    );

    const tone = (label: string) =>
      expectStatByLabel(container, label).querySelector(".qs-meter__fill")?.classList[1];
    expect(tone("CPU")).toBe("qs-meter__fill--critical");
    expect(tone("Memory")).toBe("qs-meter__fill--critical");
    expect(tone("Disk")).toBe("qs-meter__fill--warn");
  });

  it("hides Gateway host details when the RPC is unavailable", () => {
    const container = document.createElement("div");

    render(renderQuickSettings(createProps({ systemInfoUnavailable: true })), container);

    expect(container.querySelector(".qs-card--system")).toBeNull();
  });

  it("reserves the Gateway host card while its first snapshot loads", () => {
    const container = document.createElement("div");

    render(renderQuickSettings(createProps()), container);

    const systemCard = container.querySelector(".qs-card--system");
    expect(systemCard).not.toBeNull();
    expect(systemCard?.querySelector(".qs-system__name")?.textContent).toContain("—");
    for (const label of ["CPU", "Memory", "Disk"]) {
      const stat = expectStatByLabel(systemCard ?? container, label);
      expect(stat.querySelector(".qs-stat__value")?.textContent).toContain("—");
      expect(stat.querySelector(".qs-meter")).toBeNull();
    }
    expect(systemCard?.querySelector(".qs-system__address")).toBeNull();
  });

  it("hides the pending changes bar when the config is clean", () => {
    const container = document.createElement("div");

    render(renderQuickSettings(createProps()), container);

    expect(container.querySelector(".qs-pending")).toBeNull();
  });

  it("renders pending config actions and calls their handlers", () => {
    const onResetConfig = vi.fn();
    const onSaveConfig = vi.fn();
    const onApplyConfig = vi.fn();
    const container = document.createElement("div");

    render(
      renderQuickSettings(
        createProps({
          configDirty: true,
          configReady: true,
          connected: true,
          onResetConfig,
          onSaveConfig,
          onApplyConfig,
        }),
      ),
      container,
    );

    expect(container.querySelector(".qs-pending")).not.toBeNull();
    const discardButton = expectButtonByText(container, "Discard");
    const saveButton = expectButtonByText(container, "Save");
    const applyButton = expectButtonByText(container, "Apply Now");
    expect(saveButton.disabled).toBe(false);

    discardButton.click();
    saveButton.click();
    applyButton.click();

    expect(onResetConfig).toHaveBeenCalledTimes(1);
    expect(onSaveConfig).toHaveBeenCalledTimes(1);
    expect(onApplyConfig).toHaveBeenCalledTimes(1);
  });

  it("locks config-backed quick controls while a config operation is pending", () => {
    const container = document.createElement("div");

    for (const pending of [
      { configLoading: true },
      { configSaving: true },
      { configApplying: true },
      { configUpdating: true },
    ]) {
      render(renderQuickSettings(createProps({ configDirty: true, ...pending })), container);

      const thinkingRow = expectRowByLabel(container, "Thinking");
      const fastModeRow = expectRowByLabel(container, "Fast mode");
      const browserRow = expectRowByLabel(container, "Browser enabled");
      const toolProfileRow = expectRowByLabel(container, "Tool profile");
      expect([...thinkingRow.querySelectorAll("button")].every((button) => button.disabled)).toBe(
        true,
      );
      expect([...fastModeRow.querySelectorAll("button")].every((button) => button.disabled)).toBe(
        true,
      );
      expect(browserRow.querySelector("input")?.hasAttribute("disabled")).toBe(true);
      expect(
        [...toolProfileRow.querySelectorAll("button")].every((button) => button.disabled),
      ).toBe(true);
      expect(
        [...container.querySelectorAll<HTMLButtonElement>(".qs-pending__actions button")].every(
          (button) => button.disabled,
        ),
      ).toBe(true);
    }
  });

  it("disables commit actions until the config is ready", () => {
    const container = document.createElement("div");

    render(renderQuickSettings(createProps({ configDirty: true, configReady: false })), container);

    expect(expectButtonByText(container, "Save").disabled).toBe(true);
    expect(expectButtonByText(container, "Apply Now").disabled).toBe(true);
    expect(expectButtonByText(container, "Discard").disabled).toBe(false);
  });

  it("keeps auto as a first-class quick settings fast mode", () => {
    const onFastModeChange = vi.fn();
    const container = document.createElement("div");

    render(renderQuickSettings(createProps({ fastMode: "auto", onFastModeChange })), container);

    const row = expectRowByLabel(container, "Fast mode");
    const buttons = Array.from(row.querySelectorAll<HTMLButtonElement>("button"));
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      "Auto",
      "Fast",
      "Standard",
    ]);
    expect(row.querySelector(".qs-segmented__btn--active")?.textContent?.trim()).toBe("Auto");

    expectButtonByText(row, "Auto").click();
    expect(onFastModeChange).not.toHaveBeenCalled();

    expectButtonByText(row, "Standard").click();

    expect(onFastModeChange).toHaveBeenCalledWith(false);
  });

  it("lets operators change browser and tool profile from Security quick settings", () => {
    const onBrowserEnabledToggle = vi.fn();
    const onToolProfileChange = vi.fn();
    const container = document.createElement("div");

    render(
      renderQuickSettings(
        createProps({
          security: {
            gatewayAuth: "token",
            execPolicy: "allowlist",
            deviceAuth: true,
            browserEnabled: false,
            toolProfile: "messaging",
          },
          onBrowserEnabledToggle,
          onToolProfileChange,
        }),
      ),
      container,
    );

    const browserRow = expectRowByLabel(container, "Browser enabled");
    expect(browserRow.querySelector(".qs-toggle__hint")?.textContent).toBe("Disabled");
    const browserInput = browserRow.querySelector("input");
    expect(browserInput).toBeInstanceOf(HTMLInputElement);
    expect((browserInput as HTMLInputElement).checked).toBe(false);

    (browserInput as HTMLInputElement).checked = true;
    browserInput?.dispatchEvent(new Event("change"));
    expect(onBrowserEnabledToggle).toHaveBeenCalledWith(true);

    expectButtonByText(container, "full").click();
    expect(onToolProfileChange).toHaveBeenCalledWith("full");
    expect([...expectButtonByText(container, "messaging").classList]).toEqual([
      "qs-segmented__btn",
      "qs-segmented__btn--compact",
      "qs-segmented__btn--active",
    ]);
  });

  it("opens mobile pairing from Security quick settings", () => {
    const onPairMobile = vi.fn();
    const container = document.createElement("div");

    render(renderQuickSettings(createProps({ onPairMobile })), container);

    expectRowByLabel(container, "OpenClaw mobile");
    const button = expectButtonByText(container, "Pair mobile device");
    expect(button.disabled).toBe(false);
    button.click();
    expect(onPairMobile).toHaveBeenCalledOnce();
  });

  it("lets operators change text size from Appearance quick settings", () => {
    const setTextScale = vi.fn();
    const container = document.createElement("div");

    render(renderQuickSettings(createProps({ textScale: 125, setTextScale })), container);

    const textSizeRow = expectRowByLabel(container, "Text size");
    const active = Array.from(textSizeRow.querySelectorAll("button")).find((button) =>
      button.classList.contains("qs-segmented__btn--active"),
    );
    expect(active?.textContent?.trim()).toBe("XL");

    expectButtonByText(textSizeRow, "XXL").click();
    expect(setTextScale).toHaveBeenCalledWith(140);
  });

  it("keeps the local user name fixed and shows the assistant identity", () => {
    const container = document.createElement("div");

    render(
      renderQuickSettings(
        createProps({
          assistantName: "Nova",
          assistantAvatar: "assets/avatars/nova-portrait.png",
          assistantAvatarUrl: "blob:nova",
        }),
      ),
      container,
    );

    const titles = Array.from(container.querySelectorAll(".qs-identity-card__title")).map((node) =>
      node.textContent?.trim(),
    );
    expect(titles).toEqual(["You", "Nova"]);
    expect(container.querySelector('input[placeholder="You"]')).toBeNull();
    expect(
      Array.from(container.querySelectorAll(".qs-row__label")).some(
        (node) => node.textContent?.trim() === "Name",
      ),
    ).toBe(false);
    expect(container.querySelector(".qs-assistant-avatar")?.getAttribute("src")).toBe("blob:nova");
  });

  it("renders same-origin configured assistant avatar routes", () => {
    const container = document.createElement("div");

    render(
      renderQuickSettings(
        createProps({
          assistantName: "Nova",
          assistantAvatar: "/avatar/main",
          assistantAvatarUrl: "/avatar/main",
          assistantAvatarSource: "assets/avatars/nova-portrait.png",
          assistantAvatarStatus: "local",
        }),
      ),
      container,
    );

    expect(container.querySelector(".qs-assistant-avatar")?.getAttribute("src")).toBe(
      "/avatar/main",
    );
  });

  it("shows the configured avatar source when the assistant falls back to the logo", () => {
    const container = document.createElement("div");

    render(
      renderQuickSettings(
        createProps({
          assistantName: "Nova",
          assistantAvatar: "/avatar/main",
          assistantAvatarUrl: null,
          assistantAvatarSource: "assets/avatars/nova-portrait.png",
          assistantAvatarStatus: "none",
          assistantAvatarReason: "missing",
        }),
      ),
      container,
    );

    expect(container.querySelector(".qs-assistant-avatar")?.getAttribute("src")).toBe(
      "/apple-touch-icon.png",
    );
    expect(expectAssistantAvatarSource(container)).toEqual({
      label: "Configured avatar",
      source: "assets/avatars/nova-portrait.png",
    });
    expect(container.querySelector(".qs-identity-card__issue")?.textContent?.trim()).toBe(
      "File not found",
    );
    expect(
      Array.from(container.querySelectorAll("label.btn")).some(
        (label) => label.textContent?.trim() === "Choose image",
      ),
    ).toBe(true);
  });

  it("renders the gateway fallback without retrying a rejected avatar route", () => {
    const container = document.createElement("div");

    render(
      renderQuickSettings(
        createProps({
          assistantName: "Nova",
          assistantAvatar: "A",
          assistantAvatarUrl: "A",
          assistantAvatarSource: "assets/avatars/missing.png",
          assistantAvatarStatus: "none",
          assistantAvatarReason: "missing",
        }),
      ),
      container,
    );

    expect(container.querySelector(".qs-assistant-avatar--fallback")?.getAttribute("src")).toBe(
      "/apple-touch-icon.png",
    );
    expect(container.querySelector('.qs-assistant-avatar[src*="/avatar/"]')).toBeNull();
    expect(container.querySelector(".qs-identity-card__issue")?.textContent?.trim()).toBe(
      "File not found",
    );
  });

  it("shows unreadable avatar failures without retrying the protected route", () => {
    const container = document.createElement("div");

    render(
      renderQuickSettings(
        createProps({
          assistantName: "Nova",
          assistantAvatar: "A",
          assistantAvatarUrl: "A",
          assistantAvatarSource: "assets/avatars/avatar.png",
          assistantAvatarStatus: "none",
          assistantAvatarReason: "unreadable",
        }),
      ),
      container,
    );

    expect(container.querySelector('.qs-assistant-avatar[src*="/avatar/"]')).toBeNull();
    expect(container.querySelector(".qs-identity-card__issue")?.textContent?.trim()).toBe(
      "Cannot render avatar",
    );
  });

  it("keeps a bounded avatar source free of lone surrogates", () => {
    const container = document.createElement("div");
    const source = `${"a".repeat(33)}😀${"m".repeat(20)}😀${"b".repeat(23)}`;

    render(
      renderQuickSettings(
        createProps({
          assistantAvatar: "/avatar/main",
          assistantAvatarUrl: null,
          assistantAvatarSource: source,
          assistantAvatarStatus: "none",
        }),
      ),
      container,
    );

    expect(expectAssistantAvatarSource(container).source).toBe(
      `${"a".repeat(33)}...${"b".repeat(23)}`,
    );
  });

  it("keeps a malformed data-image header free of lone surrogates", () => {
    const container = document.createElement("div");
    const source = `data:image/${"a".repeat(20)}😀tail`;

    render(
      renderQuickSettings(
        createProps({
          assistantAvatar: "/avatar/main",
          assistantAvatarUrl: null,
          assistantAvatarSource: source,
          assistantAvatarStatus: "none",
        }),
      ),
      container,
    );

    expect(expectAssistantAvatarSource(container).source).toBe(`data:image/${"a".repeat(20)},...`);
  });

  it("reads assistant image imports into an override", () => {
    const onAssistantAvatarOverrideChange = vi.fn();
    const readAsDataURL = vi.fn(function (this: FileReader) {
      Object.defineProperty(this, "result", {
        configurable: true,
        value: "data:image/png;base64,YXZhdGFy",
      });
      this.dispatchEvent(new Event("load"));
    });
    class MockFileReader {
      result: string | null = null;
      listeners = new Map<string, Array<(event: Event) => void>>();
      addEventListener(type: string, listener: (event: Event) => void) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }
      dispatchEvent(event: Event) {
        for (const listener of this.listeners.get(event.type) ?? []) {
          listener(event);
        }
        return true;
      }
      readAsDataURL = readAsDataURL;
    }
    vi.stubGlobal("FileReader", MockFileReader);

    try {
      const container = document.createElement("div");
      render(
        renderQuickSettings(
          createProps({
            assistantAvatarSource: "assets/avatars/nova-portrait.png",
            assistantAvatarStatus: "none",
            assistantAvatarReason: "missing",
            onAssistantAvatarOverrideChange,
          }),
        ),
        container,
      );

      const inputs = Array.from(container.querySelectorAll('input[type="file"]'));
      const input = inputs.find((node) =>
        node.closest(".qs-identity-card--assistant"),
      ) as HTMLInputElement | null;
      expect(input?.type).toBe("file");
      if (!input) {
        throw new Error("expected assistant avatar file input");
      }

      Object.defineProperty(input, "files", {
        configurable: true,
        value: [new File(["avatar"], "avatar.png", { type: "image/png" })],
      });
      input.dispatchEvent(new Event("change"));

      expect(readAsDataURL).toHaveBeenCalledTimes(1);
      expect(onAssistantAvatarOverrideChange).toHaveBeenCalledWith(
        "data:image/png;base64,YXZhdGFy",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("can clear an assistant avatar override back to the configured avatar", () => {
    const onAssistantAvatarClearOverride = vi.fn();
    const container = document.createElement("div");

    render(
      renderQuickSettings(
        createProps({
          assistantAvatar: "data:image/png;base64,b3ZlcnJpZGU=",
          assistantAvatarUrl: "data:image/png;base64,b3ZlcnJpZGU=",
          assistantAvatarSource: "data:image/png;base64,...",
          assistantAvatarStatus: "data",
          assistantAvatarOverride: "data:image/png;base64,b3ZlcnJpZGU=",
          onAssistantAvatarClearOverride,
        }),
      ),
      container,
    );

    expect(expectAssistantAvatarSource(container)).toEqual({
      label: "UI override",
      source: "data:image/png;base64,...",
    });
    expectButtonByText(container, "Clear override").dispatchEvent(new Event("click"));

    expect(onAssistantAvatarClearOverride).toHaveBeenCalledTimes(1);
  });

  it("lets the browser-local assistant avatar override stale missing source metadata", () => {
    const dataUrl = "data:image/png;base64,bG9jYWwtYXNzaXN0YW50";
    const container = document.createElement("div");

    render(
      renderQuickSettings(
        createProps({
          assistantName: "Nova",
          assistantAvatar: "/avatar/main",
          assistantAvatarUrl: null,
          assistantAvatarSource: "avatars/missing.png",
          assistantAvatarStatus: "none",
          assistantAvatarReason: "missing",
          assistantAvatarOverride: dataUrl,
        }),
      ),
      container,
    );

    expect(container.querySelector(".qs-assistant-avatar")?.getAttribute("src")).toBe(dataUrl);
    expect(expectAssistantAvatarSource(container)).toEqual({
      label: "UI override",
      source: "data:image/png;base64,...",
    });
    expect(container.querySelector(".qs-identity-card__issue")).toBeNull();
    expect(
      Array.from(container.querySelectorAll("label.btn")).some(
        (label) => label.textContent?.trim() === "Replace image",
      ),
    ).toBe(true);
    expect(
      Array.from(container.querySelectorAll("button")).some(
        (button) => button.textContent?.trim() === "Clear override",
      ),
    ).toBe(true);
  });

  it("rejects oversized avatar uploads before reading them", () => {
    const onUserAvatarChange = vi.fn();
    const fileReader = vi.fn();
    vi.stubGlobal("FileReader", fileReader);

    try {
      const container = document.createElement("div");
      render(renderQuickSettings(createProps({ onUserAvatarChange })), container);

      const input = expectFileInput(
        Array.from(container.querySelectorAll('input[type="file"]')).find(
          (node) => !node.closest(".qs-identity-card--assistant"),
        ),
      );

      const file = new File([new Uint8Array(1_500_001)], "avatar.png", { type: "image/png" });
      Object.defineProperty(input, "files", {
        configurable: true,
        value: [file],
      });

      input.dispatchEvent(new Event("change"));

      expect(fileReader).not.toHaveBeenCalled();
      expect(onUserAvatarChange).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows an import theme option in quick settings before a theme is imported", () => {
    const container = document.createElement("div");

    render(renderQuickSettings(createProps()), container);

    expect(
      Array.from(container.querySelectorAll("button")).some(
        (button) => button.textContent?.trim() === "Import",
      ),
    ).toBe(true);
  });

  it("routes custom clicks into the tweakcn importer until a custom theme exists", () => {
    const setTheme = vi.fn();
    const onOpenCustomThemeImport = vi.fn();
    const container = document.createElement("div");

    render(
      renderQuickSettings(
        createProps({
          hasCustomTheme: false,
          setTheme,
          onOpenCustomThemeImport,
        }),
      ),
      container,
    );

    expectButtonByText(container, "Import").click();

    expect(onOpenCustomThemeImport).toHaveBeenCalledTimes(1);
    expect(setTheme).not.toHaveBeenCalled();
  });

  it("applies the imported custom theme from quick settings once it exists", () => {
    const setTheme = vi.fn();
    const onOpenCustomThemeImport = vi.fn();
    const container = document.createElement("div");

    render(
      renderQuickSettings(
        createProps({
          theme: "claw",
          hasCustomTheme: true,
          customThemeLabel: "Light Green",
          setTheme,
          onOpenCustomThemeImport,
        }),
      ),
      container,
    );

    const customThemeButton = expectButtonByText(container, "Light Green");
    customThemeButton.click();

    expect(setTheme).toHaveBeenCalledWith("custom", { element: customThemeButton });
    expect(onOpenCustomThemeImport).not.toHaveBeenCalled();
  });
});
