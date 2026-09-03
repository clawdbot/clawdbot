import { describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import { navigateMarkdownSession, type SessionLinkTarget } from "./markdown-session-links.ts";

describe("markdown session links", () => {
  it("navigates through the canonical chat session route", () => {
    const navigate = vi.fn();
    const context = {
      basePath: "",
      sessions: { state: {} },
      agents: { state: {} },
      agentSelection: { state: {} },
      gateway: { snapshot: {} },
      navigate,
    } as unknown as ApplicationContext;
    const target: SessionLinkTarget = {
      sessionKey: "agent:roboclaw:dashboard:2139bddb-3211-4641-b993-10f619f124e6",
      agentId: "roboclaw",
    };

    navigateMarkdownSession(context, target);

    expect(navigate).toHaveBeenCalledWith("chat", {
      pathname: "/chat/roboclaw/dashboard/2139bddb-3211-4641-b993-10f619f124e6",
      search: "?__openclawSessionFacePreference=1",
    });
  });
});
