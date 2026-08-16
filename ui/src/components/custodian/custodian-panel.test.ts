/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createContext } from "../../pages/custodian/custodian-page.test-harness.ts";
import { CustodianSessionStore } from "../../pages/custodian/custodian-session-store.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import "./custodian-panel.ts";

type TestCustodianPanel = HTMLElement & {
  available: boolean;
  custodianPanelOpen: boolean;
  minimizeRequestId: number;
  store: CustodianSessionStore;
  suppressed: boolean;
  updateComplete: Promise<boolean>;
};

async function mountPanel() {
  const request = vi.fn().mockResolvedValue({
    sessionId: "panel-session",
    reply: "Ready.",
    action: "none",
  });
  const { context } = createContext(request);
  const provider = createApplicationContextProvider(context);
  const store = new CustodianSessionStore();
  const panel = document.createElement("openclaw-custodian-panel") as TestCustodianPanel;
  panel.store = store;
  panel.available = true;
  panel.suppressed = true;
  provider.append(panel);
  document.body.append(provider);
  await panel.updateComplete;
  return { context, panel, request, store };
}

describe("custodian panel", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
  });

  afterEach(() => {
    document.body.replaceChildren();
    document.documentElement.style.removeProperty("--oc-custodian-reserve-bottom");
    document.documentElement.style.removeProperty("--oc-custodian-reserve-right");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("minimizes a real page conversation into the dock on route leave", async () => {
    const { context, panel, request, store } = await mountPanel();
    store.connect(context, "caretaker");
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    store.messages = [
      { id: 1, role: "assistant", text: "Ready.", at: 1, question: null, step: null },
      { id: 2, role: "user", text: "Check this system", at: 2, question: null, step: null },
    ];

    panel.suppressed = false;
    panel.minimizeRequestId = 1;
    await panel.updateComplete;

    expect(panel.custodianPanelOpen).toBe(true);
    expect(document.documentElement.style.getPropertyValue("--oc-custodian-reserve-right")).toBe(
      "440px",
    );

    panel.querySelector<HTMLButtonElement>(".cp-actions .cp-icon:last-child")!.click();
    await panel.updateComplete;
    expect(panel.custodianPanelOpen).toBe(false);

    panel.suppressed = true;
    await panel.updateComplete;

    panel.suppressed = false;
    panel.minimizeRequestId = 2;
    await panel.updateComplete;
    expect(panel.custodianPanelOpen).toBe(true);
  });

  it("hides and restores the dock across full-page suppression", async () => {
    const { panel, store } = await mountPanel();
    store.messages = [
      { id: 1, role: "user", text: "Check this system", at: 1, question: null, step: null },
    ];

    panel.suppressed = false;
    panel.minimizeRequestId = 1;
    await panel.updateComplete;
    expect(panel.custodianPanelOpen).toBe(true);

    panel.suppressed = true;
    await panel.updateComplete;
    expect(panel.custodianPanelOpen).toBe(false);

    panel.suppressed = false;
    await panel.updateComplete;
    expect(panel.custodianPanelOpen).toBe(true);

    panel.suppressed = true;
    await panel.updateComplete;
    expect(panel.custodianPanelOpen).toBe(false);
  });

  it("honors a minimize request when chat becomes available after route leave", async () => {
    const { context, panel, request, store } = await mountPanel();
    store.connect(context, "caretaker");
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    store.messages = [
      { id: 1, role: "user", text: "Check this system", at: 1, question: null, step: null },
    ];
    panel.available = false;
    panel.suppressed = false;
    panel.minimizeRequestId = 1;
    await panel.updateComplete;
    expect(panel.custodianPanelOpen).toBe(false);

    panel.available = true;
    await panel.updateComplete;
    expect(panel.custodianPanelOpen).toBe(true);
  });

  it("preserves an onboarding session variant when it minimizes into the dock", async () => {
    const { context, panel, request, store } = await mountPanel();
    store.connect(context, "onboarding");
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    store.messages = [
      {
        id: 1,
        role: "assistant",
        text: "Set up your system",
        at: 1,
        question: null,
        step: null,
      },
      { id: 2, role: "user", text: "Continue setup", at: 2, question: null, step: null },
    ];

    panel.suppressed = false;
    panel.minimizeRequestId = 1;
    await panel.updateComplete;
    const surface = panel.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
      "openclaw-custodian-surface",
    );
    await surface?.updateComplete;

    expect(store.activeVariant).toBe("onboarding");
    expect(request).toHaveBeenCalledOnce();
    expect(panel.textContent).toContain("Continue setup");
  });

  it("updates the panel mascot mood with shared sending state", async () => {
    const { panel, store } = await mountPanel();
    store.messages = [
      { id: 1, role: "user", text: "Check this system", at: 1, question: null, step: null },
    ];
    panel.suppressed = false;
    panel.minimizeRequestId = 1;
    await panel.updateComplete;

    store.sending = true;
    store.setInput("status");
    await panel.updateComplete;

    expect(
      (panel.querySelector(".cp-title openclaw-mascot") as HTMLElement & { mood: string }).mood,
    ).toBe("thinking");
  });
});
