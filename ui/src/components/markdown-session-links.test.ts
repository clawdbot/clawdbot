import { buildControlUiSessionPath } from "@openclaw/session-url-contract";
import { describe, expect, it, vi } from "vitest";
import { setSessionPathBuilder } from "../app-session-path-builder.ts";
import type { ApplicationContext } from "../app/context.ts";
import { navigateMarkdownSession, type SessionLinkTarget } from "./markdown-session-links.ts";

describe("markdown session links", () => {
  it("navigates through the canonical chat session route", () => {
    setSessionPathBuilder(buildControlUiSessionPath);
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
      pathname: "/chat/roboclaw/2139bddb",
      search: "?__openclawSessionFacePreference=1",
    });
  });
});
