/**
 * Gateway tool-resolution exclusion tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

type CreateOpenClawToolsArg = {
  clientCaps?: string[];
  cronCreatorToolAllowlist?: Array<string | { name: string; pluginId?: string }>;
  inheritedToolDenylist?: string[];
  pluginToolDenylist?: string[];
};

const hoisted = vi.hoisted(() => {
  function makeTool(name: string) {
    return {
      name,
      description: `${name} tool`,
      parameters: { type: "object", properties: {} },
      execute: vi.fn(),
    };
  }
  return {
    makeTool,
    createOpenClawToolsMock: vi.fn((_args: CreateOpenClawToolsArg) => [
      makeTool("read"),
      makeTool("sessions_spawn"),
      makeTool("cron"),
      makeTool("gateway"),
      makeTool("nodes"),
    ]),
  };
});

vi.mock("../agents/openclaw-tools.js", () => ({
  createOpenClawTools: (args: CreateOpenClawToolsArg) => hoisted.createOpenClawToolsMock(args),
}));

import { resolveGatewayScopedTools } from "./tool-resolution.js";

describe("resolveGatewayScopedTools excludeToolNames", () => {
  beforeEach(() => {
    hoisted.createOpenClawToolsMock.mockClear();
  });

  function readCreateToolsArgs(index = 0): {
    clientCaps?: string[];
    cronCreatorToolAllowlist?: Array<string | { name: string; pluginId?: string }>;
    inheritedToolDenylist?: string[];
    pluginToolDenylist?: string[];
  } {
    const args = hoisted.createOpenClawToolsMock.mock.calls[index]?.[0];
    if (!args || typeof args !== "object") {
      throw new Error("expected createOpenClawTools args");
    }
    return args as {
      clientCaps?: string[];
      cronCreatorToolAllowlist?: Array<string | { name: string; pluginId?: string }>;
      inheritedToolDenylist?: string[];
      pluginToolDenylist?: string[];
    };
  }

  it("passes gateway client capabilities into tool construction", () => {
    resolveGatewayScopedTools({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      clientCaps: ["tool-events", "inline-widgets"],
    });

    expect(readCreateToolsArgs().clientCaps).toEqual(["tool-events", "inline-widgets"]);
  });

  it("filters loopback dedup exclusions without inheriting policy denies", () => {
    const result = resolveGatewayScopedTools({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      excludeToolNames: ["read", "apply_patch"],
    });

    expect(result.tools.map((tool) => tool.name)).toEqual([
      "sessions_spawn",
      "cron",
      "gateway",
      "nodes",
    ]);
    const args = readCreateToolsArgs();
    expect(args.pluginToolDenylist).toEqual([]);
    expect(args.inheritedToolDenylist).toEqual([]);
  });

  it("keeps owner-only core tools visible only for owner loopback callers", () => {
    const ownerResult = resolveGatewayScopedTools({
      cfg: {
        gateway: { tools: { allow: ["gateway"] } },
      } as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      senderIsOwner: true,
    });
    const nonOwnerResult = resolveGatewayScopedTools({
      cfg: {
        gateway: { tools: { allow: ["gateway"] } },
      } as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      senderIsOwner: false,
    });

    expect(ownerResult.tools.map((tool) => tool.name)).toEqual([
      "read",
      "sessions_spawn",
      "cron",
      "gateway",
      "nodes",
    ]);
    expect(nonOwnerResult.tools.map((tool) => tool.name)).toEqual(["read", "sessions_spawn"]);
    const args = readCreateToolsArgs(1);
    expect(args.pluginToolDenylist).toEqual(["cron", "gateway", "nodes", "computer"]);
    expect(args.inheritedToolDenylist).toEqual(["cron", "gateway", "nodes", "computer"]);
  });

  it("keeps real gateway deny policy inheritable while excluding native dedup tools", () => {
    resolveGatewayScopedTools({
      cfg: {
        gateway: { tools: { deny: ["exec"] } },
      } as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      excludeToolNames: ["read", "apply_patch"],
    });

    const args = readCreateToolsArgs();
    expect(args.pluginToolDenylist).toEqual(["exec"]);
    expect(args.inheritedToolDenylist).toEqual(["exec"]);
  });

  it("passes final filtered tool surface to gateway cron jobs", () => {
    hoisted.createOpenClawToolsMock.mockReturnValueOnce([
      hoisted.makeTool("read"),
      hoisted.makeTool("cron"),
      hoisted.makeTool("exec"),
    ]);

    const result = resolveGatewayScopedTools({
      cfg: {
        tools: { allow: ["read", "cron"] },
      } as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
    });

    expect(result.tools.map((tool) => tool.name)).toEqual(["read", "cron"]);
    expect(readCreateToolsArgs().cronCreatorToolAllowlist).toEqual([
      { name: "read" },
      { name: "cron" },
    ]);
  });
});
