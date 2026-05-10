import { describe, expect, it, vi } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { createOpenClawCodingTools } from "./pi-tools.js";

vi.mock("./channel-tools.js", () => {
  const passthrough = <T>(tool: T) => tool;
  const stubTool = (name: string) => ({
    name,
    description: `${name} stub`,
    parameters: { type: "object", properties: {} },
    ownerOnly: true,
    execute: vi.fn(),
  });
  return {
    listChannelAgentTools: () => [stubTool("plugin_login")],
    copyChannelAgentToolMeta: passthrough,
    getChannelAgentToolMeta: () => undefined,
  };
});

describe("owner-only tool gating", () => {
  it("removes owner-only tools for unauthorized senders", () => {
    const tools = createOpenClawCodingTools({ senderIsOwner: false });
    const toolNames = tools.map((tool) => tool.name);
    expect(toolNames).not.toContain("plugin_login");
    expect(toolNames).not.toContain("cron");
    expect(toolNames).not.toContain("gateway");
    expect(toolNames).not.toContain("nodes");
  });

  it("keeps owner-only tools for authorized senders", () => {
    const tools = createOpenClawCodingTools({ senderIsOwner: true });
    const toolNames = tools.map((tool) => tool.name);
    expect(toolNames).toContain("plugin_login");
    expect(toolNames).toContain("cron");
    expect(toolNames).toContain("gateway");
    expect(toolNames).toContain("nodes");
  });

  it("keeps canvas available to unauthorized senders by current trust model", () => {
    const tools = createOpenClawCodingTools({ senderIsOwner: false });
    const toolNames = tools.map((tool) => tool.name);
    expect(toolNames).toContain("canvas");
  });

  it("defaults to removing owner-only tools when owner status is unknown", () => {
    const tools = createOpenClawCodingTools();
    const toolNames = tools.map((tool) => tool.name);
    expect(toolNames).not.toContain("plugin_login");
    expect(toolNames).not.toContain("cron");
    expect(toolNames).not.toContain("gateway");
    expect(toolNames).not.toContain("nodes");
    expect(toolNames).toContain("canvas");
  });

  it("restricts node-originated runs to the node-safe tool subset", () => {
    const tools = createOpenClawCodingTools({ messageProvider: "node", senderIsOwner: false });
    const toolNames = tools.map((tool) => tool.name);
    expect(toolNames).toContain("canvas");
    expect(toolNames).not.toContain("exec");
    expect(toolNames).not.toContain("read");
    expect(toolNames).not.toContain("write");
    expect(toolNames).not.toContain("edit");
    expect(toolNames).not.toContain("message");
    expect(toolNames).not.toContain("sessions_send");
    expect(toolNames).not.toContain("subagents");
  });
});
