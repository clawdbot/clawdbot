/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
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
}> {
  const runtimeConfig = createRuntimeConfig(sourceConfig);
  const context = {
    basePath: "",
    runtimeConfig,
  } as unknown as ApplicationContext;
  const provider = createApplicationContextProvider(context);
  const page = document.createElement("openclaw-labs-page") as LabsPageElement;
  provider.append(page);
  document.body.append(provider);
  await page.updateComplete;
  return { page, provider, runtimeConfig };
}

function labToggle(page: LabsPageElement, index: number, label: string) {
  const toggle = page.querySelectorAll<HTMLElement & { checked: boolean }>("wa-switch").item(index);
  if (!toggle) {
    throw new Error(`${label} toggle not rendered`);
  }
  return toggle;
}

function codeModeToggle(page: LabsPageElement) {
  return labToggle(page, 0, "Code Mode");
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

    expect(page.querySelector(".settings-page__intro")?.textContent).toContain("experimental");
    expect(page.querySelectorAll(".settings-row")).toHaveLength(LAB_FEATURES.length);
    expect(page.textContent).toContain("Code Mode");
    expect(page.textContent).toContain("Swarm");
    expect(codeModeToggle(page).checked).toBe(true);

    const docs = [...page.querySelectorAll<HTMLAnchorElement>(".settings-row__desc a")];
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

  it("writes an explicit false in the RFC 7396 merge patch when disabling", async () => {
    const { page, runtimeConfig } = await mountPage({
      tools: { codeMode: { enabled: true } },
    });
    const toggle = codeModeToggle(page);

    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    await vi.waitFor(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());
    expect(runtimeConfig.patch).toHaveBeenCalledWith({
      raw: { tools: { codeMode: { enabled: false } } },
      note: "labs: update codeMode",
    });
    expect(runtimeConfig.refresh).toHaveBeenCalledOnce();
  });

  it.each([
    {
      // The on position restores the shipped "auto" tier, never `true`: Labs
      // offers Auto/Off, and force-on stays a config-only power-user state.
      label: "Code Mode",
      index: 0,
      sourceConfig: { tools: { codeMode: { enabled: false } } },
      expectedPatch: { tools: { codeMode: { enabled: "auto" } } },
      note: "labs: update codeMode",
    },
    {
      label: "Swarm",
      index: 1,
      sourceConfig: { tools: { swarm: { enabled: false } } },
      expectedPatch: { tools: { swarm: { enabled: true } } },
      note: "labs: update swarm",
    },
    {
      // Enabling must pin the mode: resolveToolSearchConfig defaults an unset
      // mode to "code", so a bare `enabled: true` would select the surface with
      // the weakest recall rather than the one this row advertises.
      label: "Tool Search",
      index: 2,
      sourceConfig: { tools: { toolSearch: { enabled: false } } },
      expectedPatch: { tools: { toolSearch: { enabled: true, mode: "directory" } } },
      note: "labs: update toolSearch",
    },
    {
      label: "Lean tools for local models",
      index: 3,
      sourceConfig: {},
      expectedPatch: { agents: { defaults: { experimental: { localModelLean: true } } } },
      note: "labs: update localModelLean",
    },
    {
      // Not a boolean gate: the on state is the conservative `direct` mode, so
      // enabling here cannot start recording group or unknown conversations.
      label: "Message audit metadata",
      index: 4,
      sourceConfig: { logging: { audit: { messages: "off" } } },
      expectedPatch: { logging: { audit: { messages: "direct" } } },
      note: "labs: update auditMessages",
    },
  ])("writes the on value at the registered config path when enabling $label", async (testCase) => {
    const { page, runtimeConfig } = await mountPage(testCase.sourceConfig);
    const toggle = labToggle(page, testCase.index, testCase.label);

    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    await vi.waitFor(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());
    expect(runtimeConfig.patch).toHaveBeenCalledWith({
      raw: testCase.expectedPatch,
      note: testCase.note,
    });
  });

  it("reads a mode-valued gate as on only for the mode this row offers", async () => {
    const auditIndex = LAB_FEATURES.findIndex((feature) => feature.id === "auditMessages");

    const off = await mountPage({ logging: { audit: { messages: "off" } } });
    expect(labToggle(off.page, auditIndex, "audit").checked).toBe(false);
    off.provider.remove();

    const direct = await mountPage({ logging: { audit: { messages: "direct" } } });
    expect(labToggle(direct.page, auditIndex, "audit").checked).toBe(true);
    direct.provider.remove();

    // `all` is broader than the mode this row offers, but it is still on. Showing
    // it as off would make the switch look available and quietly narrow a choice
    // the operator made deliberately somewhere else.
    const all = await mountPage({ logging: { audit: { messages: "all" } } });
    expect(labToggle(all.page, auditIndex, "audit").checked).toBe(true);
  });

  it("turns a broader audit mode off rather than narrowing it", async () => {
    const auditIndex = LAB_FEATURES.findIndex((feature) => feature.id === "auditMessages");
    const { page, runtimeConfig } = await mountPage({
      logging: { audit: { messages: "all" } },
    });
    const toggle = labToggle(page, auditIndex, "audit");

    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    await vi.waitFor(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());
    expect(runtimeConfig.patch).toHaveBeenCalledWith({
      raw: { logging: { audit: { messages: "off" } } },
      note: "labs: update auditMessages",
    });
  });

  it("marks only the startup-scoped entry as needing a restart", async () => {
    const { page } = await mountPage({});
    const rows = [...page.querySelectorAll(".settings-row")];

    const restartRows = rows.filter((row) => row.textContent?.includes("restart"));
    expect(restartRows).toHaveLength(1);
    expect(restartRows[0]?.textContent).toContain("Message audit metadata");
  });
});

describe("LabsPage code mode enablement", () => {
  // Mirrors resolveCodeModeConfig: the shipped default is "auto", so the row
  // reads as on until an explicit `false` opts out. `true` stays a valid
  // config-only force-on and must also read as on.
  it.each([
    { label: "unset", config: {}, expected: true },
    {
      label: "object without enabled",
      config: { tools: { codeMode: { timeoutMs: 5000 } } },
      expected: true,
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

  it("writes an explicit false when disabling the shipped default", async () => {
    const { page, runtimeConfig } = await mountPage({});
    const toggle = codeModeToggle(page);

    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    await vi.waitFor(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());
    expect(runtimeConfig.patch).toHaveBeenCalledWith({
      raw: { tools: { codeMode: { enabled: false } } },
      note: "labs: update codeMode",
    });
  });
});

describe("LabsPage tool search enablement", () => {
  const toolSearchIndex = LAB_FEATURES.findIndex((feature) => feature.id === "toolSearch");

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
  ])("reads $label as $expected", async ({ config, expected }) => {
    const { page, provider } = await mountPage(config);

    expect(labToggle(page, toolSearchIndex, "Tool Search").checked).toBe(expected);
    provider.remove();
  });

  it("does not replace an operator's existing mode when already on", async () => {
    const { page, runtimeConfig } = await mountPage({
      tools: { toolSearch: { mode: "tools" } },
    });
    const toggle = labToggle(page, toolSearchIndex, "Tool Search");

    // The row reads as on, so the only move available is turning it off — it
    // cannot be clicked into overwriting `tools` with `directory`.
    expect(toggle.checked).toBe(true);
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    await vi.waitFor(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());
    expect(runtimeConfig.patch).toHaveBeenCalledWith({
      raw: { tools: { toolSearch: { enabled: false } } },
      note: "labs: update toolSearch",
    });
  });
});
