import { describe, expect, it } from "vitest";
import { buildCodexRuntimeThreadConfigForRun } from "./thread-requests.js";

describe("buildCodexRuntimeThreadConfigForRun denied inherited MCP servers", () => {
  const params = { config: {}, modelId: "gpt-5.4" } as never;

  it("disables denied servers the native config defines without restricting the surface", () => {
    const config = buildCodexRuntimeThreadConfigForRun(params, undefined, {
      nativeCodeModeEnabled: true,
      hostSystemAgentActive: false,
      deniedInheritedMcpServerNames: ["beta", "alpha", "alpha"],
    });
    expect(config.mcp_servers).toEqual({ alpha: { enabled: false }, beta: { enabled: false } });
    expect(config["features.apps"]).toBeUndefined();
  });

  it("adds nothing without denied inherited servers", () => {
    const config = buildCodexRuntimeThreadConfigForRun(params, undefined, {
      nativeCodeModeEnabled: true,
      hostSystemAgentActive: false,
      deniedInheritedMcpServerNames: [],
    });
    expect(config.mcp_servers).toBeUndefined();
  });
});
