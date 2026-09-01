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
      requestGitHubPublish: vi.fn(),
      requestPortal: vi.fn(),
      requestSessionsSend: vi.fn(),
      requestSessionsSpawn: vi.fn(),
    });

    const description = tools.find((candidate) => candidate.name === "sessions_send")?.description;
    expect(description).toContain('`targetDisposition: "queued"` or `"steered"`');
    expect(description).toContain("neither proves target completion");
  });

  it("requests publication without accepting repository or credential authority", async () => {
    const requestGitHubPublish = vi.fn(async () => ({
      type: "res" as const,
      id: "response-1",
      ok: true as const,
      payload: {
        resultJson: JSON.stringify({
          content: [{ type: "text", text: "accepted" }],
          details: { requestId: "publication-1", status: "requested" },
        }),
      },
    }));
    const tools = createWorkerSessionTools({
      requestGitHubPublish,
      requestPortal: vi.fn(),
      requestSessionsSend: vi.fn(),
      requestSessionsSpawn: vi.fn(),
    });
    const tool = tools.find((candidate) => candidate.name === "github_publish");
    expect(tool).toBeDefined();
    expect(JSON.stringify(tool?.parameters)).not.toContain("token");
    expect(JSON.stringify(tool?.parameters)).not.toContain("repository");
    expect(JSON.stringify(tool?.parameters)).not.toContain("commitMessage");
    expect(tool?.parameters && Value.Check(tool.parameters, { title: "Publish the result" })).toBe(
      true,
    );
    for (const [field, value] of [
      ["token", "secret"],
      ["repository", "openclaw/openclaw"],
      ["branch", "main"],
    ] as const) {
      expect(tool?.parameters && Value.Check(tool.parameters, { [field]: value })).toBe(false);
    }

    await tool?.execute?.("tool-call-1", { title: "Publish the result" });

    expect(requestGitHubPublish).toHaveBeenCalledWith({
      toolCallId: "tool-call-1",
      title: "Publish the result",
    });
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
      requestGitHubPublish: vi.fn(),
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
