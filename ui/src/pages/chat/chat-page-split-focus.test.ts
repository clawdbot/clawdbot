/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-page.test/"} */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nativeGateways = vi.hoisted(() => ({ current: null as NativeGatewaysCapability | null }));

// Keep this complete mock in the dedicated unit-mock-registry project.
vi.mock("./chat-pane.ts", () => ({}));
vi.mock("../../app/native-gateways.runtime.ts", () => ({
  nativeGatewaysCapability: () => nativeGateways.current,
}));

import type { NativeGatewaysCapability } from "../../app/native-gateways.runtime.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  createSplitLayout,
  itemAt,
  setLayout,
  setNavigationContext,
  stubMatchMedia,
} from "./chat-page.test-support.ts";
import { ChatPage } from "./chat-page.ts";
import type { ChatPaneElement } from "./route-draft-focus-handoff.ts";

// Split-pane close focus handoff (see #127323): closing the focused pane moves
// keyboard focus to the surviving pane composer; background closes leave focus alone.
type SplitFocusPane = ChatPaneElement & {
  paneId: string;
  onClosePane?: (paneId: string) => void;
};

async function setupSplitFocusLayout() {
  const page = new ChatPage();
  setNavigationContext(page);
  page.data = { sessionKey: "main" };
  document.body.append(page);
  setLayout(page, createSplitLayout("main"));
  await page.updateComplete;
  const panes = [...page.querySelectorAll<SplitFocusPane>("openclaw-chat-pane")];
  expect(panes).toHaveLength(2);
  for (const pane of panes) {
    const wrap = document.createElement("div");
    wrap.className = "agent-chat__composer-combobox";
    wrap.append(document.createElement("textarea"));
    pane.append(wrap);
  }
  const survivingTextarea = itemAt(panes, 0, "surviving pane").querySelector(
    "textarea",
  ) as HTMLTextAreaElement;
  const closingPane = itemAt(panes, 1, "closing pane");
  return {
    page,
    closingPane,
    survivingTextarea,
    closingTextarea: closingPane.querySelector("textarea") as HTMLTextAreaElement,
    focusSpy: vi.spyOn(survivingTextarea, "focus"),
  };
}

describe("chat page split focus handoff", () => {
  beforeEach(() => {
    nativeGateways.current = null;
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    localStorage.clear();
    stubMatchMedia(false);
  });

  afterEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("moves focus to the surviving pane composer when closing the focused pane", async () => {
    const { page, closingPane, closingTextarea, focusSpy } = await setupSplitFocusLayout();

    closingTextarea.focus();
    closingPane.onClosePane?.(closingPane.paneId);
    await page.updateComplete;
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
    page.remove();
  });

  it("leaves focus alone when closing a pane that does not own focus", async () => {
    const { page, closingPane, focusSpy } = await setupSplitFocusLayout();

    document.body.focus();
    closingPane.onClosePane?.(closingPane.paneId);
    await page.updateComplete;
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(focusSpy).not.toHaveBeenCalled();
    page.remove();
  });
});
