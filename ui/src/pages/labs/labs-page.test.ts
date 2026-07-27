/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import {
  createApplicationContextProvider,
  type ApplicationContextProvider,
} from "../../test-helpers/application-context.ts";
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

  it("renders the experimental Code Mode and Swarm entries", async () => {
    const { page } = await mountPage({
      tools: { codeMode: { enabled: true }, swarm: { enabled: true } },
    });

    expect(page.querySelector(".settings-page__intro")?.textContent).toContain("experimental");
    expect(page.querySelectorAll(".settings-row")).toHaveLength(2);
    expect(page.textContent).toContain("Code Mode");
    expect(page.textContent).toContain("Swarm");
    expect(page.textContent).not.toContain("restart required");
    expect(codeModeToggle(page).checked).toBe(true);
    expect([...page.querySelectorAll<HTMLElement & { checked: boolean }>("wa-switch")]).toEqual([
      expect.objectContaining({ checked: true }),
      expect.objectContaining({ checked: true }),
    ]);

    const docs = [...page.querySelectorAll<HTMLAnchorElement>(".settings-row__desc a")];
    expect(docs.map((link) => link.href)).toEqual([
      "https://docs.openclaw.ai/tools/code-mode",
      "https://docs.openclaw.ai/tools/swarm",
    ]);
    expect(docs.every((link) => link.target === "_blank")).toBe(true);
    expect(docs.every((link) => link.rel.includes("noopener"))).toBe(true);
  });

  it("reflects the supported boolean Code Mode shorthand", async () => {
    const { page } = await mountPage({ tools: { codeMode: true } });

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
      label: "Code Mode",
      index: 0,
      sourceConfig: { tools: { codeMode: { enabled: false } } },
      expectedPatch: { tools: { codeMode: { enabled: true } } },
      note: "labs: update codeMode",
    },
    {
      label: "Swarm",
      index: 1,
      sourceConfig: { tools: { swarm: { enabled: false } } },
      expectedPatch: { tools: { swarm: { enabled: true } } },
      note: "labs: update swarm",
    },
  ])("writes true at the registered config path when enabling $label", async (testCase) => {
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
});
