import { describe, expect, it } from "vitest";
import { resolveAgentRunContext } from "./run-context.js";

describe("resolveAgentRunContext", () => {
  it("restores the host-owned request sender when reconstructed routing context omits it", () => {
    expect(
      resolveAgentRunContext({
        message: "read the attached dossiers",
        requestMessageId: "1785653731.956149",
        requestSenderId: "U028EKM2A",
        runContext: {
          messageChannel: "slack",
          currentThreadTs: "1785653731.956149",
        },
      }),
    ).toMatchObject({
      messageChannel: "slack",
      currentThreadTs: "1785653731.956149",
      senderId: "U028EKM2A",
    });
  });

  it("rejects an actor without its paired host-owned request message", () => {
    expect(() =>
      resolveAgentRunContext({
        message: "read the attached dossiers",
        requestSenderId: "U028EKM2A",
      }),
    ).toThrow("requestSenderId requires requestMessageId.");
  });

  it("rejects disagreement between the host-owned actor and routing context", () => {
    expect(() =>
      resolveAgentRunContext({
        message: "read the attached dossiers",
        requestMessageId: "1785653731.956149",
        requestSenderId: "U028EKM2A",
        runContext: { senderId: "U_OTHER" },
      }),
    ).toThrow("requestSenderId must match the agent run context sender.");
  });
});
