import { describe, expect, it, vi } from "vitest";
import { applyDelegationCapability, resolveDelegationCapability } from "./delegation-capability.js";
import type { AnyAgentTool } from "./tools/common.js";

function createTool(
  name: string,
  execute = vi.fn(async () => ({ content: [], details: {} })),
): AnyAgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: {} as never,
    execute,
  } as unknown as AnyAgentTool;
}

describe("delegation capability", () => {
  it("enters report-only mode only for fallback completion reports", () => {
    expect(
      resolveDelegationCapability({
        fallbackActive: true,
        inputProvenance: { kind: "inter_session", sourceTool: "subagent_announce" },
      }),
    ).toBe("report_only");
    expect(
      resolveDelegationCapability({
        fallbackActive: true,
        inputProvenance: { kind: "inter_session", sourceTool: "agent_harness_task" },
      }),
    ).toBe("report_only");
    expect(
      resolveDelegationCapability({
        fallbackActive: false,
        inputProvenance: { kind: "inter_session", sourceTool: "subagent_announce" },
      }),
    ).toBe("full");
    expect(
      resolveDelegationCapability({
        fallbackActive: true,
        inputProvenance: { kind: "external_user" },
      }),
    ).toBe("full");
  });

  it("removes delegation tools but retains ordinary reporting tools", () => {
    const tools = [
      createTool("sessions_spawn"),
      createTool("sessions_send"),
      createTool("openclaw"),
      createTool("llm-task"),
      createTool("codex_session_send"),
      createTool("message"),
      createTool("gateway"),
      createTool("sessions_history"),
    ];

    expect(applyDelegationCapability(tools, "report_only").map((tool) => tool.name)).toEqual([
      "message",
      "gateway",
      "sessions_history",
    ]);
    expect(applyDelegationCapability(tools, "full")).toBe(tools);
  });

  it("keeps status and cleanup actions while rejecting new background work", async () => {
    const cronExecute = vi.fn(async () => ({ content: [], details: {} }));
    const imageExecute = vi.fn(async () => ({ content: [], details: {} }));
    const [cron, image] = applyDelegationCapability(
      [createTool("cron", cronExecute), createTool("image_generate", imageExecute)],
      "report_only",
    );

    await expect(cron?.execute("cron-status", { action: "status" })).resolves.toEqual({
      content: [],
      details: {},
    });
    await expect(cron?.execute("cron-remove", { action: "remove" })).resolves.toEqual({
      content: [],
      details: {},
    });
    await expect(cron?.execute("cron-add", { action: "add" })).rejects.toThrow(
      "New delegation is unavailable",
    );
    await expect(image?.execute("image-status", { action: "status" })).resolves.toEqual({
      content: [],
      details: {},
    });
    await expect(image?.execute("image-generate", {})).rejects.toThrow(
      "New delegation is unavailable",
    );
    expect(cronExecute).toHaveBeenCalledTimes(2);
    expect(imageExecute).toHaveBeenCalledTimes(1);
  });
});
