import { afterEach, describe, expect, it } from "vitest";
import type { NewSessionRouteData } from "./location.ts";
import "./new-session-page.ts";

type TestNewSessionPage = {
  data: NewSessionRouteData | undefined;
  folder: string;
  message: string;
  openedFor: string | null;
  visibility: "normal" | "draft" | "incognito";
  worktree: boolean;
  setMessageFromUser(message: string): void;
  updated(): void;
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

afterEach(() => {
  window.history.replaceState({}, "", "/");
});

describe("new session draft route ownership", () => {
  it("clears all source draft state when destination data is still pending", () => {
    const page = document.createElement(
      "openclaw-new-session-page",
    ) as unknown as TestNewSessionPage;
    page.data = routeData("research");
    page.updated();
    window.history.replaceState({}, "", "/new?agent=research");
    page.setMessageFromUser("source draft");
    page.folder = "/workspace/source";
    page.visibility = "incognito";
    page.worktree = true;

    window.history.replaceState({}, "", "/new?agent=research&catalog=claude");
    page.data = undefined;
    page.updated();

    expect(page.message).toBe("");
    expect(page.folder).toBe("");
    expect(page.visibility).toBe("normal");
    expect(page.worktree).toBe(false);
    expect(page.openedFor).toBe(JSON.stringify(["research", "claude"]));
  });

  it("keeps destination input through pending data, settlement, and agent resolution", () => {
    const page = document.createElement(
      "openclaw-new-session-page",
    ) as unknown as TestNewSessionPage;
    page.data = routeData("research");
    page.updated();

    window.history.replaceState({}, "", "/new?agent=research&catalog=claude");
    page.data = undefined;
    page.updated();
    page.setMessageFromUser("keep this fast draft");

    page.data = {
      ...routeData("", "claude"),
      requestedAgentId: "research",
    };
    page.updated();
    expect(page.message).toBe("keep this fast draft");

    page.data = routeData("research", "claude");
    page.updated();

    expect(page.message).toBe("keep this fast draft");
  });

  it("clears a draft when a different route settles without destination-owned input", () => {
    const page = document.createElement(
      "openclaw-new-session-page",
    ) as unknown as TestNewSessionPage;
    page.data = routeData("research", "claude");
    page.updated();
    window.history.replaceState({}, "", "/new?agent=research&catalog=claude");
    page.setMessageFromUser("route-owned draft");

    window.history.replaceState({}, "", "/new?agent=main&catalog=codex");
    page.data = undefined;
    page.updated();

    expect(page.message).toBe("");
  });
});
