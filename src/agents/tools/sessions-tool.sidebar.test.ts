import { describe, expect, it, vi } from "vitest";
import { createSessionsTool } from "./sessions-tool.js";

describe("sessions tool sidebar settings", () => {
  it("patches and clears title, icon, category, status, attention, and archive state", async () => {
    const callGateway = vi.fn(async () => ({ ok: true }));
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:main",
      agentSessionId: "session-main",
      config: {},
      callGateway: callGateway as never,
    });

    await tool.execute("declare", {
      action: "patch",
      label: "Waiting on staging",
      icon: "🦞",
      category: "P1 issues from beta feedback",
      statusNote: "Blocked: need the staging password",
      attention: "key",
      ttlMinutes: 45,
      archived: true,
    });
    await tool.execute("clear", {
      action: "patch",
      label: "",
      icon: "",
      category: "",
      attention: "clear",
    });
    await tool.execute("clear-null", { action: "patch", category: null });

    expect(callGateway.mock.calls).toEqual([
      [
        {
          method: "sessions.patch",
          params: {
            key: "agent:main:main",
            label: "Waiting on staging",
            icon: "🦞",
            category: "P1 issues from beta feedback",
            statusNote: "Blocked: need the staging password",
            attention: "key",
            ttlMinutes: 45,
            archived: true,
            expectedSessionId: "session-main",
          },
        },
      ],
      [
        {
          method: "sessions.patch",
          params: {
            key: "agent:main:main",
            label: null,
            icon: null,
            category: null,
            attention: null,
          },
        },
      ],
      [
        {
          method: "sessions.patch",
          params: {
            key: "agent:main:main",
            category: null,
          },
        },
      ],
    ]);
  });
});
