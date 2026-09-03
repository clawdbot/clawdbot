import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import {
  PORTAL_TOOL_DESCRIPTION,
  PortalOutputSchema,
  PortalToolSchema,
} from "../agents/tools/portal-tool-contract.js";
import { createWorkerSessionTools } from "./worker-session-tools.js";

describe("worker Gateway tools", () => {
  it("keeps session admission separate from announcement delivery", () => {
    const tools = createWorkerSessionTools({
      requestPortal: vi.fn(),
      requestSessionsSend: vi.fn(),
      requestSessionsSpawn: vi.fn(),
    });

    const description = tools.find((candidate) => candidate.name === "sessions_send")?.description;
    expect(description).toContain('`targetDisposition: "queued"` or `"steered"`');
    expect(description).toContain("neither proves target completion");
  });

  it("forwards portal actions through the shared Gateway portal tool contract", async () => {
    const requestPortal = vi.fn(async () => ({
      type: "res" as const,
      id: "response-portal",
      ok: true as const,
      payload: {
        resultJson: JSON.stringify({
          content: [{ type: "text", text: "Portal available" }],
          details: { id: "worker-portal" },
        }),
      },
    }));
    const tools = createWorkerSessionTools({
      requestPortal,
      requestSessionsSend: vi.fn(),
      requestSessionsSpawn: vi.fn(),
    });
    const portal = tools.find((candidate) => candidate.name === "portal");

    expect(portal?.description).toBe(PORTAL_TOOL_DESCRIPTION);
    expect(portal?.parameters).toBe(PortalToolSchema);
    expect(portal?.outputSchema).toBe(PortalOutputSchema);
    expect(Value.Check(PortalToolSchema, { action: "open", port: 3000, path: "/app" })).toBe(true);
    expect(Value.Check(PortalToolSchema, { action: "open", port: 0 })).toBe(false);

    await expect(portal?.execute?.("portal-call", { action: "open", port: 3000 })).resolves.toEqual(
      {
        content: [{ type: "text", text: "Portal available" }],
        details: { id: "worker-portal" },
      },
    );
    expect(requestPortal).toHaveBeenCalledWith({
      toolCallId: "portal-call",
      action: "open",
      port: 3000,
    });
  });
});
