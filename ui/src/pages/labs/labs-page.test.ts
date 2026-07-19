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

function codeModeToggle(page: LabsPageElement) {
  const toggle = page.querySelector<HTMLElement & { checked: boolean }>("wa-switch");
  if (!toggle) {
    throw new Error("Code Mode toggle not rendered");
  }
  return toggle;
}

describe("LabsPage", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("renders the experimental Code Mode entry without the schema-pending Swarm entry", async () => {
    const { page } = await mountPage({ tools: { codeMode: { enabled: true } } });

    expect(page.querySelector(".settings-page__intro")?.textContent).toContain("experimental");
    expect(page.querySelectorAll(".settings-row")).toHaveLength(1);
    expect(page.textContent).toContain("Code Mode");
    expect(page.textContent).not.toContain("Swarm");
    expect(page.textContent).not.toContain("restart required");
    expect(codeModeToggle(page).checked).toBe(true);

    const docs = page.querySelector<HTMLAnchorElement>(".settings-row__desc a");
    expect(docs?.href).toBe("https://docs.openclaw.ai/tools/code-mode");
    expect(docs?.target).toBe("_blank");
    expect(docs?.rel).toContain("noopener");
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

  it("writes true at the registered config path when enabling", async () => {
    const { page, runtimeConfig } = await mountPage({
      tools: { codeMode: { enabled: false } },
    });
    const toggle = codeModeToggle(page);

    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    await vi.waitFor(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());
    expect(runtimeConfig.patch).toHaveBeenCalledWith({
      raw: { tools: { codeMode: { enabled: true } } },
      note: "labs: update codeMode",
    });
  });
});
