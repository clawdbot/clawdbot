import { afterEach, describe, expect, it } from "vitest";
import { t } from "../../i18n/index.ts";
import type { NewSessionRouteData } from "./location.ts";
import "./new-session-page-entry.ts";

type NewSessionElement = HTMLElement & {
  data: NewSessionRouteData | undefined;
  updateComplete: Promise<boolean>;
};

function routeData(agentId: string, catalogId = ""): NewSessionRouteData {
  return {
    agentId,
    requestedAgentId: agentId,
    catalogId,
    model: "",
    catalogLabel: "",
    startTerminal: false,
  };
}

async function mount(data: NewSessionRouteData): Promise<NewSessionElement> {
  const page = document.createElement("openclaw-new-session-page") as NewSessionElement;
  page.data = data;
  document.body.append(page);
  await settle(page);
  return page;
}

async function settle(page: NewSessionElement) {
  await page.updateComplete;
  await page.updateComplete;
}

async function enterMessage(page: NewSessionElement, value: string) {
  const textarea = page.querySelector<HTMLTextAreaElement>(".new-session-page__message");
  expect(textarea).not.toBeNull();
  if (!textarea) {
    return;
  }
  textarea.value = value;
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
  await settle(page);
}

function message(page: NewSessionElement): string {
  return page.querySelector<HTMLTextAreaElement>(".new-session-page__message")?.value ?? "";
}

afterEach(() => {
  document.querySelectorAll("openclaw-new-session-page").forEach((element) => element.remove());
  sessionStorage.clear();
  window.history.replaceState({}, "", "/");
});

describe("new session draft route ownership", () => {
  it("focuses the composer from the structural main focus anchor", async () => {
    const page = await mount(routeData("research"));
    const textarea = page.querySelector<HTMLTextAreaElement>(".new-session-page__message");
    const main = document.createElement("main");
    main.tabIndex = -1;
    page.append(main);
    main.focus();

    main.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true, composed: true }));

    expect(document.activeElement).toBe(textarea);
  });

  it("leaves Space with a focused agent-menu option", async () => {
    const page = await mount(routeData("research"));
    const menuItem = document.createElement("div");
    menuItem.setAttribute("role", "menuitemradio");
    menuItem.tabIndex = -1;
    let selected = false;
    menuItem.addEventListener("keydown", (event) => {
      if (event.key === " ") {
        selected = true;
      }
    });
    page.append(menuItem);
    menuItem.focus();

    menuItem.dispatchEvent(
      new KeyboardEvent("keydown", { key: " ", bubbles: true, composed: true }),
    );

    expect(selected).toBe(true);
    expect(document.activeElement).toBe(menuItem);
    expect(message(page)).toBe("");
  });

  it("leaves shortcuts, composition, and other form controls alone", async () => {
    const page = await mount(routeData("research"));
    const textarea = page.querySelector<HTMLTextAreaElement>(".new-session-page__message");

    for (const init of [
      { key: "x", ctrlKey: true },
      { key: "x", metaKey: true },
      { key: "Tab" },
      { key: "Escape" },
      { key: "Process", isComposing: true },
    ]) {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { ...init, bubbles: true, composed: true }),
      );
      expect(document.activeElement).not.toBe(textarea);
    }

    const openOverlay = Object.assign(document.createElement("div"), { open: true });
    const overlayItem = document.createElement("div");
    openOverlay.append(overlayItem);
    for (const control of [
      document.createElement("input"),
      document.createElement("select"),
      document.createElement("textarea"),
      Object.assign(document.createElement("div"), { contentEditable: "true" }),
    ]) {
      page.append(control);
      control.focus();
      control.dispatchEvent(
        new KeyboardEvent("keydown", { key: "x", bubbles: true, composed: true }),
      );
      expect(document.activeElement).toBe(control);
    }

    page.append(openOverlay);
    overlayItem.dispatchEvent(
      new KeyboardEvent("keydown", { key: "x", bubbles: true, composed: true }),
    );
    expect(document.activeElement).not.toBe(textarea);
  });

  it("labels the message input independently of its placeholder", async () => {
    const page = await mount(routeData("research"));
    const textarea = page.querySelector<HTMLTextAreaElement>(".new-session-page__message");

    expect(textarea?.getAttribute("aria-label")).toBe(t("newSession.messagePlaceholder"));
  });

  it("clears source draft state when destination data is still pending", async () => {
    const page = await mount(routeData("research"));
    window.history.replaceState({}, "", "/new?agent=research");
    await enterMessage(page, "source draft");

    window.history.replaceState({}, "", "/new?agent=research&catalog=claude");
    page.data = undefined;
    await settle(page);

    expect(message(page)).toBe("");
  });

  it("keeps destination input through pending data, settlement, and agent resolution", async () => {
    const page = await mount(routeData("research"));

    window.history.replaceState({}, "", "/new?agent=research&catalog=claude");
    page.data = undefined;
    await settle(page);
    await enterMessage(page, "keep this fast draft");

    page.data = { ...routeData("", "claude"), requestedAgentId: "research" };
    await settle(page);
    expect(message(page)).toBe("keep this fast draft");

    page.data = routeData("research", "claude");
    await settle(page);
    expect(message(page)).toBe("keep this fast draft");
  });

  it("clears a draft when a different route settles without destination-owned input", async () => {
    const page = await mount(routeData("research", "claude"));
    window.history.replaceState({}, "", "/new?agent=research&catalog=claude");
    await enterMessage(page, "route-owned draft");

    window.history.replaceState({}, "", "/new?agent=main&catalog=codex");
    page.data = undefined;
    await settle(page);

    expect(message(page)).toBe("");
  });
});
