/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderQuickSettings } from "./quick.ts";

type QuickSettingsProps = Parameters<typeof renderQuickSettings>[0];

type QuickControl = HTMLElement & { checked?: boolean; disabled: boolean };

function expectButtonByText(container: Element, text: string): QuickControl {
  const button = Array.from(container.querySelectorAll<QuickControl>("button, wa-radio")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!(button instanceof HTMLElement)) {
    throw new Error(`Expected button labelled ${text}`);
  }
  return button;
}

function selectRadio(control: QuickControl) {
  if (control.checked) {
    return;
  }
  const group = control.closest<HTMLElement & { value: string }>("wa-radio-group");
  expect(group).not.toBeNull();
  if (!group) {
    return;
  }
  group.value = control.getAttribute("value") ?? "";
  group.dispatchEvent(new Event("change", { bubbles: true }));
}

function expectRowByTitle(container: Element, text: string): HTMLElement {
  const row = Array.from(container.querySelectorAll<HTMLElement>(".settings-row")).find(
    (candidate) => candidate.querySelector(".settings-row__title")?.textContent?.trim() === text,
  );
  if (!(row instanceof HTMLElement)) {
    throw new Error(`Expected quick settings row "${text}"`);
  }
  return row;
}

function expectStatByLabel(container: Element, text: string): HTMLElement {
  const stat = Array.from(container.querySelectorAll<HTMLElement>(".config-host__stat")).find(
    (candidate) =>
      candidate.querySelector(".config-host__stat-label")?.textContent?.trim() === text,
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
    currentModel: "gpt-5.5",
    thinkingLevel: "off",
    fastMode: false,
    onModelChange: vi.fn(),
    onThinkingChange: vi.fn(),
    onFastModeChange: vi.fn(),
    connected: true,
    assistantName: "OpenClaw",
    version: "2026.4.22",
    ...overrides,
  };
}

describe("renderQuickSettings", () => {
  it("renders the slim general hub with stable target ids", () => {
    const container = document.createElement("div");

    render(renderQuickSettings(createProps()), container);

    expect(container.querySelectorAll(".settings-page")).toHaveLength(1);
    const targetIds = Array.from(
      container.querySelectorAll<HTMLElement>("[id^='settings-general-']"),
    ).map((element) => element.id);
    expect(targetIds).toEqual(["settings-general-model", "settings-general-system"]);
    // One group surface per section; no nested cards. Channels, security,
    // automations, appearance, and identity all have dedicated pages now.
    for (const id of targetIds) {
      const section = container.querySelector(`#${id}`);
      expect(section?.querySelectorAll(".settings-group")).toHaveLength(1);
      expect(section?.querySelector(".settings-group .settings-group")).toBeNull();
    }
  });

  it("changes the Control UI language from General settings", () => {
    const onLocaleChange = vi.fn();
    const container = document.createElement("div");

    render(renderQuickSettings(createProps({ locale: "pt-BR", onLocaleChange })), container);

    const row = expectRowByTitle(container, "Language");
    const select = row.querySelector<HTMLElement & { value: string }>("wa-select");
    if (!(select instanceof HTMLElement)) {
      throw new Error("Expected language selector");
    }
    expect(select.getAttribute("value")).toBe("pt-BR");
    Object.defineProperty(select, "value", { configurable: true, value: "en" });
    select.dispatchEvent(new Event("change"));
    expect(onLocaleChange).toHaveBeenCalledWith("en");
  });

  it("drills into model settings from the Model row", () => {
    const onModelChange = vi.fn();
    const container = document.createElement("div");

    render(renderQuickSettings(createProps({ onModelChange })), container);

    const row = expectRowByTitle(container, "Model");
    expect(row.classList.contains("settings-row--nav")).toBe(true);
    expect(row.querySelector(".settings-row__value")?.textContent?.trim()).toBe("gpt-5.5");
    row.click();
    expect(onModelChange).toHaveBeenCalledTimes(1);
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

    const name = container.querySelector(".config-host__name");
    expect(name?.textContent?.trim()).toBe("Gateway Mac");
    expect(name?.getAttribute("title")).toBe("gateway.local");
    expect(container.querySelector(".config-host__address")?.textContent?.trim()).toBe(
      "192.168.1.20:18789",
    );
    const metas = Array.from(container.querySelectorAll(".config-host__meta")).map((node) =>
      node.textContent?.trim(),
    );
    expect(metas).toEqual(["macOS 26.5.0 · arm64", "Node v24.1.0 · PID 1234"]);
    expect(
      container
        .querySelector("#settings-general-system .settings-section__actions .settings-status")
        ?.textContent?.trim(),
    ).toBe("Up 1h");

    const cpu = expectStatByLabel(container, "CPU");
    expect(
      cpu.querySelector(".config-host__stat-value")?.textContent?.replace(/\s+/g, " ").trim(),
    ).toBe("1.2 load");
    expect(cpu.querySelector(".config-host__stat-detail")?.textContent?.trim()).toBe("10 cores");
    expect(cpu.getAttribute("title")).toBe("Apple M4 · Load average: 1.2 · 1.1 · 0.9");
    expect(cpu.querySelector(".config-host__meter")?.getAttribute("aria-valuenow")).toBe("12");

    const memory = expectStatByLabel(container, "Memory");
    expect(
      memory.querySelector(".config-host__stat-value")?.textContent?.replace(/\s+/g, " ").trim(),
    ).toBe("50% used");
    expect(memory.querySelector(".config-host__stat-detail")?.textContent?.trim()).toBe(
      "16 GB free of 32 GB",
    );

    const disk = expectStatByLabel(container, "Disk");
    expect(
      disk.querySelector(".config-host__stat-value")?.textContent?.replace(/\s+/g, " ").trim(),
    ).toBe("50% used");
    expect(disk.querySelector(".config-host__stat-detail")?.textContent?.trim()).toBe(
      "463 GB free of 926 GB",
    );
    expect(disk.getAttribute("title")).toBe("/Users/operator/.openclaw");
    for (const fill of container.querySelectorAll(".config-host__meter-fill")) {
      expect([...fill.classList]).toContain("config-host__meter-fill--ok");
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
      expectStatByLabel(container, label).querySelector(".config-host__meter-fill")?.classList[1];
    expect(tone("CPU")).toBe("config-host__meter-fill--critical");
    expect(tone("Memory")).toBe("config-host__meter-fill--critical");
    expect(tone("Disk")).toBe("config-host__meter-fill--warn");
  });

  it("hides Gateway host details when the RPC is unavailable", () => {
    const container = document.createElement("div");

    render(renderQuickSettings(createProps({ systemInfoUnavailable: true })), container);

    expect(container.querySelector("#settings-general-system")).toBeNull();
  });

  it("reserves the Gateway host section while its first snapshot loads", () => {
    const container = document.createElement("div");

    render(renderQuickSettings(createProps()), container);

    const systemSection = container.querySelector("#settings-general-system");
    expect(systemSection).not.toBeNull();
    expect(systemSection?.querySelector(".config-host__name")?.textContent).toContain("—");
    for (const label of ["CPU", "Memory", "Disk"]) {
      const stat = expectStatByLabel(systemSection ?? container, label);
      expect(stat.querySelector(".config-host__stat-value")?.textContent).toContain("—");
      expect(stat.querySelector(".config-host__meter")).toBeNull();
    }
    expect(systemSection?.querySelector(".config-host__address")).toBeNull();
  });

  it("hides the restart banner while the config needs no apply", () => {
    const container = document.createElement("div");

    render(renderQuickSettings(createProps()), container);

    expect(container.querySelector(".config-apply-banner")).toBeNull();
    expect(expectButtonByText.bind(null, container, "Save")).toThrow();
    expect(expectButtonByText.bind(null, container, "Apply Now")).toThrow();
  });

  it("renders the restart banner and wires it to apply", () => {
    const onApplyConfig = vi.fn();
    const container = document.createElement("div");

    render(renderQuickSettings(createProps({ configNeedsApply: true, onApplyConfig })), container);

    const banner = container.querySelector(".config-apply-banner");
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain("Saved to openclaw.json — restart the gateway to apply.");
    const applyButton = expectButtonByText(container, "Restart & apply");
    expect(applyButton.disabled).toBe(false);
    applyButton.click();
    expect(onApplyConfig).toHaveBeenCalledTimes(1);
  });

  it("gates the restart action while a raw draft is pending", () => {
    const container = document.createElement("div");

    // apply() always refuses while a raw draft is unsaved; an enabled button
    // here would be a dead action with a misleading generic failure.
    render(
      renderQuickSettings(createProps({ configNeedsApply: true, configRawDraftPending: true })),
      container,
    );

    expect(expectButtonByText(container, "Restart & apply").disabled).toBe(true);
  });

  it("surfaces the shared autosave status with its recovery actions", () => {
    const container = document.createElement("div");

    render(renderQuickSettings(createProps()), container);
    expect(container.querySelector(".config-toolbar__status")).toBeNull();

    render(renderQuickSettings(createProps({ configAutoSaveStatus: "saving" })), container);
    expect(container.querySelector(".config-toolbar__status")?.textContent?.trim()).toBe("Saving…");

    const onRetrySaveConfig = vi.fn();
    render(
      renderQuickSettings(createProps({ configAutoSaveStatus: "error", onRetrySaveConfig })),
      container,
    );
    expect(container.querySelector(".config-toolbar__status")?.textContent).toContain(
      "Save failed",
    );
    expectButtonByText(container, "Retry").click();
    expect(onRetrySaveConfig).toHaveBeenCalledTimes(1);

    const onDiscardConfig = vi.fn();
    render(
      renderQuickSettings(createProps({ configAutoSaveStatus: "conflict", onDiscardConfig })),
      container,
    );
    expect(container.querySelector(".config-toolbar__status")?.textContent).toContain(
      "Settings changed elsewhere",
    );
    expectButtonByText(container, "Reload").click();
    expect(onDiscardConfig).toHaveBeenCalledTimes(1);
  });

  it("shows a busy restart banner while applying", () => {
    const container = document.createElement("div");

    render(
      renderQuickSettings(createProps({ configNeedsApply: true, configApplying: true })),
      container,
    );

    const banner = container.querySelector(".config-apply-banner");
    expect(banner?.textContent).toContain("Applying…");
    expect(banner?.querySelector("button")?.disabled).toBe(true);

    // Other in-flight config writes gate the action too.
    render(
      renderQuickSettings(createProps({ configNeedsApply: true, configSaving: true })),
      container,
    );
    expect(container.querySelector(".config-apply-banner button")?.hasAttribute("disabled")).toBe(
      true,
    );
    render(
      renderQuickSettings(createProps({ configNeedsApply: true, configAutoSaveStatus: "saving" })),
      container,
    );
    expect(container.querySelector(".config-apply-banner button")?.hasAttribute("disabled")).toBe(
      true,
    );
    render(
      renderQuickSettings(createProps({ configNeedsApply: true, configUpdating: true })),
      container,
    );
    expect(container.querySelector(".config-apply-banner button")?.hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("locks config-backed quick controls while a config operation is pending", () => {
    for (const pending of [
      { configLoading: true },
      { configSaving: true },
      { configApplying: true },
      { configUpdating: true },
    ]) {
      const onThinkingChange = vi.fn();
      const onFastModeChange = vi.fn();
      const container = document.createElement("div");
      render(
        renderQuickSettings(createProps({ onThinkingChange, onFastModeChange, ...pending })),
        container,
      );

      const thinkingButton = expectButtonByText(expectRowByTitle(container, "Thinking"), "High");
      expect(
        (thinkingButton.closest("wa-radio-group") as HTMLElement & { disabled?: boolean }).disabled,
      ).toBe(true);
      thinkingButton.click();
      expect(onThinkingChange).not.toHaveBeenCalled();
      const fastButton = expectButtonByText(expectRowByTitle(container, "Fast mode"), "Fast");
      expect(
        (fastButton.closest("wa-radio-group") as HTMLElement & { disabled?: boolean }).disabled,
      ).toBe(true);
      fastButton.click();
      expect(onFastModeChange).not.toHaveBeenCalled();
    }
  });

  it("keeps auto as a first-class quick settings fast mode", () => {
    const onFastModeChange = vi.fn();
    const container = document.createElement("div");

    render(renderQuickSettings(createProps({ fastMode: "auto", onFastModeChange })), container);

    const row = expectRowByTitle(container, "Fast mode");
    const buttons = Array.from(row.querySelectorAll<QuickControl>("wa-radio"));
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      "Auto",
      "Fast",
      "Standard",
    ]);
    expect(row.querySelector(".settings-segmented__btn--active")?.textContent?.trim()).toBe("Auto");

    selectRadio(expectButtonByText(row, "Auto"));
    expect(onFastModeChange).not.toHaveBeenCalled();

    selectRadio(expectButtonByText(row, "Standard"));

    expect(onFastModeChange).toHaveBeenCalledWith(false);
  });
});
