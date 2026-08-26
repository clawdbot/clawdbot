import { vi, type Mock } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

export const EMPTY_CONFIG_SNAPSHOT = {
  exists: false,
  valid: true,
  config: {},
  issues: [],
};

export function createWizardTestRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

type WizardStateMocks = {
  readConfigFileSnapshot: Mock;
  resolveGatewayPort: Mock;
  probeGatewayReachable: Mock;
  resolveControlUiLinks: Mock;
  resolveLocalControlUiProbeLinks: Mock;
  resolveAdvertisedControlUiLinks: Mock;
  inspectWindowsGatewayFirewall: Mock;
  summarizeExistingConfig: Mock;
  createClackPrompter: Mock;
};

export function setupBaseWizardTestState(mocks: WizardStateMocks, config: OpenClawConfig = {}) {
  mocks.readConfigFileSnapshot.mockResolvedValue({ ...EMPTY_CONFIG_SNAPSHOT, config });
  mocks.resolveGatewayPort.mockReturnValue(18789);
  mocks.probeGatewayReachable.mockResolvedValue({ ok: false });
  mocks.resolveControlUiLinks.mockReturnValue({ wsUrl: "ws://127.0.0.1:18789" });
  mocks.resolveLocalControlUiProbeLinks.mockReturnValue({
    httpUrl: "http://127.0.0.1:18789/",
    wsUrl: "ws://127.0.0.1:18789",
  });
  mocks.resolveAdvertisedControlUiLinks.mockResolvedValue({
    httpUrl: "http://127.0.0.1:18789/",
    wsUrl: "ws://127.0.0.1:18789",
  });
  mocks.inspectWindowsGatewayFirewall.mockResolvedValue({
    applies: false,
    severity: "info",
    code: "windows_firewall_not_applicable",
    message: "Windows LAN firewall diagnostics do not apply.",
    details: [],
  });
  mocks.summarizeExistingConfig.mockReturnValue("");
  mocks.createClackPrompter.mockReturnValue({
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async () => {}),
    select: vi.fn(async () => "firecrawl"),
    multiselect: vi.fn(async () => []),
    text: vi.fn(async () => ""),
    confirm: vi.fn(async () => true),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
  });
}

export function queueWizardTestPrompts(
  mocks: {
    clackSelect: Mock;
    clackConfirm: Mock;
    clackText: Mock;
    clackIntro: Mock;
    clackOutro: Mock;
  },
  params: { select: string[]; confirm: boolean[]; text?: string },
) {
  const selectQueue = [...params.select];
  const confirmQueue = [...params.confirm];
  mocks.clackSelect.mockImplementation(async () => selectQueue.shift());
  mocks.clackConfirm.mockImplementation(async () => confirmQueue.shift());
  mocks.clackText.mockResolvedValue(params.text ?? "");
  mocks.clackIntro.mockResolvedValue(undefined);
  mocks.clackOutro.mockResolvedValue(undefined);
}

export function createSearchProviderOption(overrides: Record<string, unknown>) {
  return overrides;
}

export function createEnabledWebSearchConfig(
  provider: string,
  pluginEntry: Record<string, unknown>,
) {
  return (cfg: OpenClawConfig) => ({
    ...cfg,
    tools: {
      ...cfg.tools,
      web: {
        ...cfg.tools?.web,
        search: {
          provider,
          enabled: true,
        },
      },
    },
    plugins: {
      ...cfg.plugins,
      entries: {
        ...cfg.plugins?.entries,
        [provider]: pluginEntry,
      },
    },
  });
}
