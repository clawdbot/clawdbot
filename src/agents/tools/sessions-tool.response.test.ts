import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionsTool } from "./sessions-tool.js";
import {
  adversarialResolved,
  escapeHeavyResolved,
  expectExactResolvedAcknowledgement,
  expectOmittedResolvedAcknowledgement,
  expectedResolvedOmission,
} from "./sessions-tool.test-helpers.js";

const gatewayMocks = vi.hoisted(() => ({ callGateway: vi.fn() }));
vi.mock("../../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../gateway/call.js")>()),
  callGateway: gatewayMocks.callGateway,
}));

beforeEach(() => {
  gatewayMocks.callGateway.mockReset();
});

function createTool() {
  return createSessionsTool({
    agentSessionKey: "agent:main:main",
    config: {},
    hasInProcessGatewayContext: () => true,
  });
}

describe("sessions tool responses", () => {
  it("routes group actions to existing gateway methods", async () => {
    gatewayMocks.callGateway.mockImplementation(async (request) => request);
    const tool = createTool();

    await tool.execute("list", { action: "group_list" });
    await tool.execute("set", { action: "group_set", names: ["Now", "Later"] });
    await tool.execute("rename", { action: "group_rename", name: "Now", to: "Next" });
    await tool.execute("delete", { action: "group_delete", name: "Later" });

    expect(gatewayMocks.callGateway.mock.calls).toEqual([
      [{ method: "sessions.groups.list", params: {} }],
      [{ method: "sessions.groups.put", params: { names: ["Now", "Later"] } }],
      [{ method: "sessions.groups.rename", params: { name: "Now", to: "Next" } }],
      [{ method: "sessions.groups.delete", params: { name: "Later" } }],
    ]);
    await expect(tool.execute("set-missing", { action: "group_set" })).rejects.toThrow(
      "names required",
    );
    await expect(
      tool.execute("set-invalid", { action: "group_set", names: ["Now", null] }),
    ).rejects.toThrow("names[1] required");
    expect(gatewayMocks.callGateway).toHaveBeenCalledTimes(4);
  });

  it("returns a bounded acknowledgement instead of the patched session entry", async () => {
    gatewayMocks.callGateway.mockResolvedValue({
      ok: true,
      path: `/sessions/${"p".repeat(10_000)}`,
      key: "agent:main:main",
      entry: {
        skillsSnapshot: "s".repeat(47_469),
        sessionDiffBaseline: "b".repeat(3_665),
      },
      resolved: { modelProvider: "openai", model: "gpt-5.6-luna" },
    });
    const tool = createTool();

    const result = await tool.execute("patch-sidebar", { action: "patch", label: "Movies" });

    expect(gatewayMocks.callGateway).toHaveBeenCalledWith({
      method: "sessions.patch",
      params: { key: "agent:main:main", label: "Movies" },
    });
    expect(result.details).toEqual({
      status: "updated",
      sessionKey: "agent:main:main",
      updated: ["label"],
    });
    const text = (result.content[0] as { text?: string } | undefined)?.text ?? "";
    expect(text).not.toContain('"entry"');
    expect(text).not.toContain('"path"');
    expect(text).not.toContain('"resolved"');
    expect(text).not.toContain("skillsSnapshot");
    expect(text).not.toContain("sessionDiffBaseline");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(512);
  });

  it("returns authoritative resolved model and thinking metadata without the patched entry", async () => {
    const resolved = {
      modelProvider: "openai",
      model: "gpt-5.6-luna",
      agentRuntime: { id: "codex", fallback: "openclaw" as const, source: "session" as const },
      thinkingLevel: "medium",
      thinkingLevels: [
        { id: "off", label: "Off" },
        { id: "medium", label: "Medium" },
      ],
    };
    gatewayMocks.callGateway.mockResolvedValue({
      ok: true,
      path: `/sessions/${"p".repeat(10_000)}`,
      key: "agent:main:main",
      entry: { skillsSnapshot: "s".repeat(47_469) },
      resolved,
    });
    const tool = createTool();

    const result = await tool.execute("patch-model-thinking", {
      action: "patch",
      model: "openai/luna",
      thinkingLevel: "med",
    });

    expect(result.details).toEqual({
      status: "updated",
      sessionKey: "agent:main:main",
      updated: ["model", "thinkingLevel"],
      resolved,
    });
    const text = (result.content[0] as { text?: string } | undefined)?.text ?? "";
    expect(text).not.toContain('"entry"');
    expect(text).not.toContain('"path"');
    expect(text).not.toContain("skillsSnapshot");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(1_024);
  });

  it("preserves the complete canonical thinking catalog through ultra", async () => {
    const thinkingLevels = [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "adaptive",
      "max",
      "ultra",
    ].map((id) => ({ id, label: id }));
    gatewayMocks.callGateway.mockResolvedValue({
      ok: true,
      path: "/sessions/main",
      key: "agent:main:main",
      entry: {},
      resolved: { thinkingLevel: "ultra", thinkingLevels },
    });
    const tool = createTool();

    const result = await tool.execute("patch-ultra-thinking", {
      action: "patch",
      thinkingLevel: "ultra",
    });

    expect(result.details).toMatchObject({
      resolved: { thinkingLevel: "ultra", thinkingLevels },
    });
  });

  it("preserves long resolved identifiers and complete catalogs exactly when they fit", async () => {
    gatewayMocks.callGateway.mockResolvedValue({
      ok: true,
      path: `/sessions/${"p".repeat(10_000)}`,
      key: "agent:main:main",
      entry: { skillsSnapshot: "s".repeat(47_469) },
      resolved: adversarialResolved,
    });
    const tool = createTool();

    const result = await tool.execute("patch-adversarial-model-thinking", {
      action: "patch",
      model: "openai/luna",
      thinkingLevel: "med",
    });

    expect(result.details).toMatchObject({
      status: "updated",
      sessionKey: "agent:main:main",
      updated: ["model", "thinkingLevel"],
    });
    expectExactResolvedAcknowledgement(result, adversarialResolved);
  });

  it("omits oversized resolved metadata instead of changing authoritative identifiers", async () => {
    gatewayMocks.callGateway.mockResolvedValue({
      ok: true,
      path: `/sessions/${"p".repeat(10_000)}`,
      key: "agent:main:main",
      entry: { skillsSnapshot: "s".repeat(47_469) },
      resolved: escapeHeavyResolved,
    });
    const tool = createTool();

    const result = await tool.execute("patch-oversized-model-thinking", {
      action: "patch",
      model: "openai/luna",
      thinkingLevel: "med",
    });

    expect(result.details).toMatchObject({
      status: "updated",
      sessionKey: "agent:main:main",
      updated: ["model", "thinkingLevel"],
      resolvedOmitted: expectedResolvedOmission,
    });
    expectOmittedResolvedAcknowledgement(result);
  });
});
