/**
 * Gateway tool-resolution exclusion tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

type CreateOpenClawToolsArg = {
  inheritedToolDenylist?: string[];
  pluginToolDenylist?: string[];
};

const hoisted = vi.hoisted(() => ({
  createOpenClawToolsMock: vi.fn((_args: CreateOpenClawToolsArg) => [
    {
      name: "read",
      description: "Read files",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(),
    },
    {
      name: "sessions_spawn",
      description: "Spawn sessions",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(),
    },
  ]),
}));

vi.mock("../agents/openclaw-tools.js", () => ({
  createOpenClawTools: (args: CreateOpenClawToolsArg) => hoisted.createOpenClawToolsMock(args),
}));

import { resolveGatewayScopedTools } from "./tool-resolution.js";

describe("resolveGatewayScopedTools excludeToolNames", () => {
  beforeEach(() => {
    hoisted.createOpenClawToolsMock.mockClear();
  });

  function readCreateToolsArgs(): {
    inheritedToolDenylist?: string[];
    pluginToolDenylist?: string[];
  } {
    const args = hoisted.createOpenClawToolsMock.mock.calls[0]?.[0];
    if (!args || typeof args !== "object") {
      throw new Error("expected createOpenClawTools args");
    }
    return args as {
      inheritedToolDenylist?: string[];
      pluginToolDenylist?: string[];
    };
  }

  it("filters loopback dedup exclusions without inheriting policy denies", () => {
    const result = resolveGatewayScopedTools({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:direct:test",
      surface: "loopback",
      excludeToolNames: ["read", "apply_patch"],
    });

    expect(result.tools.map((tool) => tool.name)).toEqual(["sessions_spawn"]);
    const args = readCreateToolsArgs();
    expect(args.pluginToolDenylist).toEqual([]);
    expect(args.inheritedToolDenylist).toEqual([]);
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
});
