import { describe, expect, it, vi } from "vitest";
import { getPluginToolMeta, setPluginToolMeta } from "../plugins/tool-metadata.js";
import { applyDelegationCapability, resolveDelegationCapability } from "./delegation-capability.js";
import { attachToolAllowlistIntersection } from "./tool-policy.js";
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
  it("enters report-only mode for fallback completion reports", () => {
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

  it.each([
    { sourceTool: "subagent_announce", disableTools: true },
    { sourceTool: "agent_harness_task", disableTools: true },
    { sourceTool: "subagent_announce", toolsAllow: [] },
    { sourceTool: "subagent_announce", toolsAllow: ["message"] },
    { sourceTool: "agent_harness_task", toolsAllow: ["message"] },
  ])(
    "blocks new delegation for restricted $sourceTool completion reports",
    ({ sourceTool, ...restriction }) => {
      expect(
        resolveDelegationCapability({
          fallbackActive: false,
          inputProvenance: { kind: "inter_session", sourceTool },
          ...restriction,
        }),
      ).toBe("report_only");
    },
  );

  it.each([
    { label: "wildcard", toolsAllow: ["*"] },
    { label: "wildcard with another tool", toolsAllow: ["message", "*"] },
    { label: "session launch", toolsAllow: ["sessions_spawn"] },
    { label: "session glob", toolsAllow: ["sessions_*"] },
    { label: "session group", toolsAllow: ["group:sessions"] },
    { label: "OpenClaw delegation", toolsAllow: ["openclaw"] },
  ])("preserves $label delegation for completion reports", ({ toolsAllow }) => {
    expect(
      resolveDelegationCapability({
        fallbackActive: false,
        inputProvenance: { kind: "inter_session", sourceTool: "subagent_announce" },
        toolsAllow,
      }),
    ).toBe("full");
  });

  it("preserves independent allowlist intersections for completion reports", () => {
    const toolsAllow = attachToolAllowlistIntersection(
      ["sessions_spawn", "message"],
      [["sessions_spawn", "message"], ["message"]],
    );

    expect(
      resolveDelegationCapability({
        fallbackActive: false,
        inputProvenance: { kind: "inter_session", sourceTool: "subagent_announce" },
        toolsAllow,
      }),
    ).toBe("report_only");
  });

  it.each([
    { label: "message-only", toolsAllow: ["message"] },
    { label: "image generation", toolsAllow: ["image_generate"] },
    { label: "disabled tools", disableTools: true },
  ])("keeps $label non-completion runs at full delegation capability", (restriction) => {
    expect(
      resolveDelegationCapability({
        fallbackActive: false,
        inputProvenance: { kind: "external_user" },
        ...restriction,
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

  it("preserves plugin ownership metadata through the report-only wrapper", () => {
    const cron = createTool("cron");
    setPluginToolMeta(cron, { pluginId: "scheduler" } as never);

    const [wrapped] = applyDelegationCapability([cron], "report_only");

    // The effective cron-creator allowlist reads meta off the returned tool, so
    // a wrapper that drops it would silently unown the plugin's tool.
    expect(wrapped).not.toBe(cron);
    expect(getPluginToolMeta(wrapped as AnyAgentTool)).toEqual({ pluginId: "scheduler" });
  });
});
