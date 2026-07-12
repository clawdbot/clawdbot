// Tests gateway active-run matching by logical session key and backing id.
import { expect, it } from "vitest";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-events.js";
import {
  hasVisibleActiveSessionRun,
  resolveVisibleActiveSessionRunState,
} from "./session-active-runs.js";

it("matches session-id-only gateway runs during archive admission", () => {
  const context = {
    chatAbortControllers: new Map([
      [
        "run-1",
        {
          sessionId: "session-1",
          controlUiVisible: true,
          projectSessionActive: true,
        },
      ],
    ]),
  } as never;

  expect(
    hasVisibleActiveSessionRun({
      context,
      requestedKey: "agent:main:child",
      canonicalKey: "agent:main:child",
      sessionId: "session-1",
    }),
  ).toBe(true);
});

it("returns deterministic visible run ids for the selected session", () => {
  const context = {
    chatAbortControllers: new Map([
      ["run-z", { sessionKey: "main" }],
      ["run-hidden", { sessionKey: "main", controlUiVisible: false }],
      ["run-other", { sessionKey: "other" }],
      ["run-a", { sessionKey: "main" }],
    ]),
  } as never;

  expect(
    resolveVisibleActiveSessionRunState({
      context,
      requestedKey: "main",
      canonicalKey: "main",
    }),
  ).toEqual({ active: true, runIds: ["run-a", "run-z"] });
});

it("projects a lifecycle-owned worker run without widening event visibility", () => {
  registerAgentRunContext("worker-run", {
    isControlUiVisible: false,
    projectSessionActive: true,
    sessionId: "worker-session",
    sessionKey: "agent:main:worker",
  });
  try {
    expect(
      resolveVisibleActiveSessionRunState({
        context: {},
        requestedKey: "agent:main:worker",
        canonicalKey: "agent:main:worker",
        sessionId: "worker-session",
      }),
    ).toEqual({ active: true, runIds: [] });
  } finally {
    clearAgentRunContext("worker-run");
  }
});
