/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import {
  createApplicationContextProvider,
  type ApplicationContextProvider,
} from "../../test-helpers/application-context.ts";
import { LAB_FEATURES } from "./labs-registry.ts";
import "./labs-page.ts";

type LabsPageElement = HTMLElement & { updateComplete: Promise<boolean> };

type RuntimeConfigState = {
  connected: boolean;
  configLoading: boolean;
  configSnapshot: {
    hash: string;
    sourceConfig: Record<string, unknown>;
  } | null;
  lastError: string | null;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function createGateway() {
  const client = {} as GatewayBrowserClient;
  let snapshot = { client, phase: "connected" } as ApplicationGatewaySnapshot;
  const listeners = new Set<(snapshot: ApplicationGatewaySnapshot) => void>();
  return {
    gateway: {
      get snapshot() {
        return snapshot;
      },
      subscribe(listener: (snapshot: ApplicationGatewaySnapshot) => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    } as unknown as ApplicationContext["gateway"],
    setPhase(phase: ApplicationGatewaySnapshot["phase"]) {
      snapshot = { ...snapshot, phase };
      listeners.forEach((listener) => listener(snapshot));
    },
  };
}

function createRuntimeConfig(sourceConfig: Record<string, unknown>) {
  const state: RuntimeConfigState = {
    connected: true,
    configLoading: false,
    configSnapshot: { hash: "config-hash", sourceConfig },
    lastError: null,
  };
  const listeners = new Set<(state: RuntimeConfigState) => void>();
  return {
    state,
    ensureLoaded: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    patch: vi.fn(async () => true),
    subscribe(listener: (state: RuntimeConfigState) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

async function mountPage(sourceConfig: Record<string, unknown>): Promise<{
  page: LabsPageElement;
  provider: ApplicationContextProvider;
  runtimeConfig: ReturnType<typeof createRuntimeConfig>;
  gateway: ReturnType<typeof createGateway>;
}> {
  const runtimeConfig = createRuntimeConfig(sourceConfig);
  const gateway = createGateway();
  const context = {
    basePath: "",
    gateway: gateway.gateway,
    runtimeConfig,
  } as unknown as ApplicationContext;
  const provider = createApplicationContextProvider(context);
  const page = document.createElement("openclaw-labs-page") as LabsPageElement;
  provider.append(page);
  document.body.append(provider);
  await page.updateComplete;
  return { page, provider, runtimeConfig, gateway };
}

function labRow(page: LabsPageElement, title: string) {
  const row = [...page.querySelectorAll<HTMLElement>(".settings-row")].find(
    (candidate) => candidate.querySelector(".settings-row__title")?.textContent?.trim() === title,
  );
  if (!row) {
    throw new Error(`${title} row not rendered`);
  }
  return row;
}

function labToggle(page: LabsPageElement, title: string) {
  const toggle = labRow(page, title).querySelector<HTMLElement & { checked: boolean }>("wa-switch");
  if (!toggle) {
    throw new Error(`${title} toggle not rendered`);
  }
  return toggle;
}

function labDocsLink(page: LabsPageElement, title: string) {
  const link = labRow(page, title).querySelector<HTMLAnchorElement>(".settings-row__desc a");
  if (!link) {
    throw new Error(`${title} documentation link not rendered`);
  }
  return link;
}

function codeModeToggle(page: LabsPageElement) {
  return labToggle(page, "Code Mode");
}

describe("LabsPage", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("renders every registered experimental entry with its documentation link", async () => {
    const { page } = await mountPage({
      tools: { codeMode: { enabled: true }, swarm: { enabled: true } },
    });

    expect(page.querySelector(".page-subtitle")?.textContent).toContain("experimental");
    expect(page.querySelector(".settings-page__intro")).toBeNull();
    const introLink = page.querySelector<HTMLAnchorElement>(".page-subtitle a");
    expect(introLink?.textContent?.trim()).toBe("Learn more");
    expect(introLink?.href).toBe("https://docs.openclaw.ai/concepts/experimental-features");
    expect(page.querySelectorAll(".settings-row")).toHaveLength(LAB_FEATURES.length);
    expect(page.textContent).toContain("Code Mode");
    expect(page.textContent).toContain("Swarm");
    expect(page.textContent).toContain("Host Desktop");
    expect(page.textContent).toContain("Cloud Worker Desktop");
    expect(codeModeToggle(page).checked).toBe(true);

    const docs = LAB_FEATURES.map((feature) => labDocsLink(page, feature.title()));
    expect(docs.map((link) => link.href)).toEqual(LAB_FEATURES.map((feature) => feature.docsUrl));
    expect(docs.every((link) => link.target === "_blank")).toBe(true);
    expect(docs.every((link) => link.rel.includes("noopener"))).toBe(true);
  });

  it("reflects the supported boolean Code Mode shorthand", async () => {
    const { page } = await mountPage({ tools: { codeMode: true } });

    expect(codeModeToggle(page).checked).toBe(true);
  });

  it("reads the per-model auto tier as enabled", async () => {
    const { page } = await mountPage({ tools: { codeMode: { enabled: "auto" } } });

    expect(codeModeToggle(page).checked).toBe(true);
  });

  it.each([
    {
      label: "Code Mode",
      sourceConfig: { tools: { codeMode: { enabled: true } } },
      expectedPatch: { tools: { codeMode: { enabled: null } } },
      note: "labs: update codeMode",
    },
    {
      label: "Lean tools for local models",
      sourceConfig: { agents: { defaults: { experimental: { localModelLean: true } } } },
      expectedPatch: { agents: { defaults: { experimental: { localModelLean: null } } } },
      note: "labs: update localModelLean",
    },
    {
      label: "Custom plugin UI",
      sourceConfig: { gateway: { controlUi: { experimental: { customPlugins: true } } } },
      expectedPatch: { gateway: { controlUi: { experimental: { customPlugins: null } } } },
      note: "labs: update customPluginUi",
    },
  ])(
    "restores the default through the canonical patch flow when disabling $label",
    async (testCase) => {
      const { page, runtimeConfig } = await mountPage(testCase.sourceConfig);
      const toggle = labToggle(page, testCase.label);
      expect(toggle.checked).toBe(true);

      toggle.checked = false;
      toggle.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

      await vi.waitFor(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());
      expect(runtimeConfig.patch).toHaveBeenCalledWith({
        raw: testCase.expectedPatch,
        note: testCase.note,
      });
      expect(runtimeConfig.refresh).not.toHaveBeenCalled();
    },
  );

  it("does not publish a retired save failure after a same-client reconnect", async () => {
    const pendingPatch = deferred<boolean>();
    const { gateway, page, runtimeConfig } = await mountPage({
      tools: { codeMode: { enabled: false } },
    });
    runtimeConfig.patch.mockImplementationOnce(() => pendingPatch.promise);
    const toggle = codeModeToggle(page);

    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    await vi.waitFor(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());

    gateway.setPhase("reconnecting");
    gateway.setPhase("connected");
    pendingPatch.resolve(false);
    await pendingPatch.promise;
    await page.updateComplete;

    expect(page.querySelector('[role="alert"]')).toBeNull();
    expect(toggle.checked).toBe(false);
  });

  it.each([
    {
      // The on position selects the "auto" tier, never `true`: Labs offers
      // Auto/Off, and force-on stays a config-only power-user state.
      label: "Code Mode",
      sourceConfig: { tools: { codeMode: { enabled: false } } },
      expectedPatch: { tools: { codeMode: { enabled: "auto" } } },
      note: "labs: update codeMode",
    },
    {
      // Enabling must pin the mode: resolveToolSearchConfig defaults an unset
      // mode to "code", so a bare `enabled: true` would select the surface with
      // the weakest recall rather than the one this row advertises.
      label: "Tool Search for all models",
      sourceConfig: { tools: { toolSearch: { enabled: false } } },
      expectedPatch: { tools: { toolSearch: { enabled: true, mode: "directory" } } },
      note: "labs: update toolSearch",
    },
    {
      label: "Tool-loop detection",
      sourceConfig: { tools: { loopDetection: { enabled: false } } },
      expectedPatch: { tools: { loopDetection: { enabled: true } } },
      note: "labs: update loopDetection",
    },
    {
      label: "Lean tools for local models",
      sourceConfig: {},
      expectedPatch: { agents: { defaults: { experimental: { localModelLean: true } } } },
      note: "labs: update localModelLean",
    },
    {
      label: "CLI agents",
      sourceConfig: {},
      expectedPatch: { gateway: { cliAgents: { enabled: true } } },
      note: "labs: update cliAgents",
    },
    {
      label: "Custom plugin UI",
      sourceConfig: {},
      expectedPatch: { gateway: { controlUi: { experimental: { customPlugins: true } } } },
      note: "labs: update customPluginUi",
    },
    {
      // Not a boolean gate: the on state is the conservative `direct` mode, so
      // enabling here cannot start recording group or unknown conversations.
      label: "Message audit metadata",
      sourceConfig: { logging: { audit: { messages: "off" } } },
      expectedPatch: { logging: { audit: { messages: "direct" } } },
      note: "labs: update auditMessages",
    },
    {
      label: "Host Desktop",
      sourceConfig: { desktop: { host: { enabled: false } } },
      expectedPatch: { desktop: { host: { enabled: true } } },
      note: "labs: update hostDesktop",
    },
    {
      label: "Cloud Worker Desktop",
      sourceConfig: { cloudWorkers: { desktop: false } },
      expectedPatch: { cloudWorkers: { desktop: true } },
      note: "labs: update workerDesktop",
    },
  ])("writes the on value at the registered config path when enabling $label", async (testCase) => {
    const { page, runtimeConfig } = await mountPage(testCase.sourceConfig);
    const toggle = labToggle(page, testCase.label);
    expect(toggle.checked).toBe(false);

    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    await vi.waitFor(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());
    expect(runtimeConfig.patch).toHaveBeenCalledWith({
      raw: testCase.expectedPatch,
      note: testCase.note,
    });
  });

  it("reads a mode-valued gate as on only for the mode this row offers", async () => {
    const off = await mountPage({ logging: { audit: { messages: "off" } } });
    expect(labToggle(off.page, "Message audit metadata").checked).toBe(false);
    off.provider.remove();

    const direct = await mountPage({ logging: { audit: { messages: "direct" } } });
    expect(labToggle(direct.page, "Message audit metadata").checked).toBe(true);
    direct.provider.remove();

    // `all` is broader than the mode this row offers, but it is still on. Showing
    // it as off would make the switch look available and quietly narrow a choice
    // the operator made deliberately somewhere else.
    const all = await mountPage({ logging: { audit: { messages: "all" } } });
    expect(labToggle(all.page, "Message audit metadata").checked).toBe(true);
  });

  it("restores the default off mode from a broader audit mode", async () => {
    const { page, runtimeConfig } = await mountPage({
      logging: { audit: { messages: "all" } },
    });
    const toggle = labToggle(page, "Message audit metadata");

    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    await vi.waitFor(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());
    expect(runtimeConfig.patch).toHaveBeenCalledWith({
      raw: { logging: { audit: { messages: null } } },
      note: "labs: update auditMessages",
    });
  });

  it("marks startup-scoped entries as needing a restart", async () => {
    const { page } = await mountPage({});
    const rows = [...page.querySelectorAll(".settings-row")];

    const restartRows = rows.filter((row) => row.textContent?.toLowerCase().includes("restart"));
    expect(restartRows).toHaveLength(4);
    expect(restartRows.map((row) => row.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Message audit metadata"),
        expect.stringContaining("Custom plugin UI"),
        expect.stringContaining("Host Desktop"),
        expect.stringContaining("Cloud Worker Desktop"),
      ]),
    );
    expect(labRow(page, "Custom plugin UI").textContent).toContain(
      "Restart the Gateway and reload this browser tab",
    );
  });

  it("shows default provenance", async () => {
    const inherited = await mountPage({});
    expect(labRow(inherited.page, "Code Mode").textContent).toContain("Using default: Disabled");
    expect(labRow(inherited.page, "Swarm").textContent).toContain("Using default: Enabled");
    inherited.provider.remove();

    const overridden = await mountPage({
      tools: {
        codeMode: { enabled: "auto" },
        swarm: { enabled: false },
      },
    });
    expect(labRow(overridden.page, "Code Mode").textContent).toContain("Default: Disabled");
    expect(labRow(overridden.page, "Swarm").textContent).toContain("Default: Enabled");
  });
});

describe("LabsPage swarm enablement", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it.each([
    { label: "unset", config: {}, expected: true, overridden: false },
    { label: "empty object", config: { tools: { swarm: {} } }, expected: true, overridden: false },
    {
      label: "limits-only object",
      config: { tools: { swarm: { maxConcurrent: 3 } } },
      expected: true,
      overridden: false,
    },
    { label: "boolean true", config: { tools: { swarm: true } }, expected: true, overridden: true },
    {
      label: "explicit enabled",
      config: { tools: { swarm: { enabled: true } } },
      expected: true,
      overridden: true,
    },
    {
      label: "boolean false",
      config: { tools: { swarm: false } },
      expected: false,
      overridden: true,
    },
    {
      label: "explicit disabled with limits",
      config: { tools: { swarm: { enabled: false, maxConcurrent: 3 } } },
      expected: false,
      overridden: true,
    },
  ])(
    "reads $label as $expected with an enabled default",
    async ({ config, expected, overridden }) => {
      const { page } = await mountPage(config);

      expect(labToggle(page, "Swarm").checked).toBe(expected);
      expect(labRow(page, "Swarm").textContent).toContain(
        overridden ? "Default: Enabled" : "Using default: Enabled",
      );
    },
  );

  it("writes an explicit opt-out when disabling the default", async () => {
    const { page, runtimeConfig } = await mountPage({});
    const toggle = labToggle(page, "Swarm");
    expect(toggle.checked).toBe(true);

    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    await vi.waitFor(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());
    expect(runtimeConfig.patch).toHaveBeenCalledWith({
      raw: { tools: { swarm: { enabled: false } } },
      note: "labs: update swarm",
    });
  });

  it.each([
    {
      label: "object gate without removing limits",
      swarm: { enabled: false, maxConcurrent: 3 },
      reset: { enabled: null },
    },
    { label: "boolean shorthand", swarm: false, reset: null },
  ])("restores the enabled default by resetting the $label", async ({ swarm, reset }) => {
    const { page, runtimeConfig } = await mountPage({ tools: { swarm } });
    const toggle = labToggle(page, "Swarm");
    expect(toggle.checked).toBe(false);

    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    await vi.waitFor(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());
    expect(runtimeConfig.patch).toHaveBeenCalledWith({
      raw: { tools: { swarm: reset } },
      note: "labs: update swarm",
    });
  });
});

describe("LabsPage code mode enablement", () => {
  // Mirrors resolveCodeModeConfig: omitted `enabled` is off for every object
  // shape, while explicit `true` and `"auto"` remain opt-ins.
  it.each([
    { label: "unset", config: {}, expected: false },
    { label: "empty object", config: { tools: { codeMode: {} } }, expected: false },
    {
      label: "object with options",
      config: { tools: { codeMode: { timeoutMs: 5000 } } },
      expected: false,
    },
    { label: "explicit true", config: { tools: { codeMode: { enabled: true } } }, expected: true },
    {
      label: "explicit disabled",
      config: { tools: { codeMode: { enabled: false } } },
      expected: false,
    },
    { label: "boolean shorthand false", config: { tools: { codeMode: false } }, expected: false },
    { label: "auto shorthand", config: { tools: { codeMode: "auto" } }, expected: true },
  ])("reads $label as $expected", async ({ config, expected }) => {
    const { page, provider } = await mountPage(config);

    expect(codeModeToggle(page).checked).toBe(expected);
    provider.remove();
  });

  it("writes the auto tier when enabling the shipped default", async () => {
    const { page, runtimeConfig } = await mountPage({});
    const toggle = codeModeToggle(page);

    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    await vi.waitFor(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());
    expect(runtimeConfig.patch).toHaveBeenCalledWith({
      raw: { tools: { codeMode: { enabled: "auto" } } },
      note: "labs: update codeMode",
    });
  });

  it("writes the auto tier when re-enabling an option-bearing object", async () => {
    const { page, runtimeConfig } = await mountPage({
      tools: { codeMode: { enabled: false, timeoutMs: 5000 } },
    });
    const toggle = codeModeToggle(page);

    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    await vi.waitFor(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());
    expect(runtimeConfig.patch).toHaveBeenCalledWith({
      raw: { tools: { codeMode: { enabled: "auto" } } },
      note: "labs: update codeMode",
    });
  });
});

describe("LabsPage tool search enablement", () => {
  // readToolSearchConfig + readBoolean(raw.enabled, configured): an object that
  // configures anything besides `enabled` is already on at runtime.
  it.each([
    { label: "boolean shorthand", config: { tools: { toolSearch: true } }, expected: true },
    {
      label: "explicit enabled",
      config: { tools: { toolSearch: { enabled: true } } },
      expected: true,
    },
    {
      label: "mode without enabled",
      config: { tools: { toolSearch: { mode: "tools" } } },
      expected: true,
    },
    {
      label: "explicit disabled",
      config: { tools: { toolSearch: { enabled: false } } },
      expected: false,
    },
    { label: "boolean false", config: { tools: { toolSearch: false } }, expected: false },
    { label: "unset", config: {}, expected: false },
    {
      label: "local model without a global override",
      config: { agents: { defaults: { model: "ollama/qwen3.5:4b" } } },
      expected: false,
    },
  ])("reads $label as $expected", async ({ config, expected }) => {
    const { page, provider } = await mountPage(config);

    expect(labToggle(page, "Tool Search for all models").checked).toBe(expected);
    provider.remove();
  });

  it("restores a mode-only override at the Tool Search owner boundary", async () => {
    const { page, runtimeConfig } = await mountPage({
      tools: { toolSearch: { mode: "tools" } },
    });
    const toggle = labToggle(page, "Tool Search for all models");

    expect(toggle.checked).toBe(true);
    expect(labRow(page, "Tool Search for all models").textContent).toContain("Default: Disabled");
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    await vi.waitFor(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());
    expect(runtimeConfig.patch).toHaveBeenCalledWith({
      raw: { tools: { toolSearch: null } },
      note: "labs: update toolSearch",
    });
  });

  it("enables an explicit-disabled override with the recommended mode", async () => {
    const { page, runtimeConfig } = await mountPage({
      tools: { toolSearch: { enabled: false, mode: "tools" } },
    });
    const toggle = labToggle(page, "Tool Search for all models");

    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    await vi.waitFor(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());
    expect(runtimeConfig.patch).toHaveBeenCalledWith({
      raw: { tools: { toolSearch: { enabled: true, mode: "directory" } } },
      note: "labs: update toolSearch",
    });
  });
});

describe("LabsPage tool loop detection enablement", () => {
  // Mirrors resolveToolLoopDetectionConfig and the detector default: only an
  // explicit true enables the rolling-history detectors.
  it.each([
    { label: "unset", config: {}, expected: false },
    {
      label: "explicit enabled",
      config: { tools: { loopDetection: { enabled: true } } },
      expected: true,
    },
    {
      label: "explicit disabled",
      config: { tools: { loopDetection: { enabled: false } } },
      expected: false,
    },
  ])("reads $label as $expected", async ({ config, expected }) => {
    const { page, provider } = await mountPage(config);

    expect(labToggle(page, "Tool-loop detection").checked).toBe(expected);
    provider.remove();
  });

  it("patches only enabled so sibling settings remain untouched", async () => {
    const { page, runtimeConfig } = await mountPage({
      tools: { loopDetection: { enabled: false, warningThreshold: 12 } },
    });
    const toggle = labToggle(page, "Tool-loop detection");

    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    await vi.waitFor(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());
    expect(runtimeConfig.patch).toHaveBeenCalledWith({
      raw: { tools: { loopDetection: { enabled: true } } },
      note: "labs: update loopDetection",
    });
  });

  it("restores the disabled default instead of pinning false", async () => {
    const { page, runtimeConfig } = await mountPage({
      tools: { loopDetection: { enabled: true, warningThreshold: 12 } },
    });
    const toggle = labToggle(page, "Tool-loop detection");

    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    await vi.waitFor(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());
    expect(runtimeConfig.patch).toHaveBeenCalledWith({
      raw: { tools: { loopDetection: { enabled: null } } },
      note: "labs: update loopDetection",
    });
  });
});
