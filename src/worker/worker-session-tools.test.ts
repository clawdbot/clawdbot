import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { createWorkerSessionTools } from "./worker-session-tools.js";

describe("worker Gateway tools", () => {
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
});
