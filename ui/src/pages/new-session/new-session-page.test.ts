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
