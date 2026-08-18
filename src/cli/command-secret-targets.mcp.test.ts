import { describe, expect, it } from "vitest";
import { getMcpCommandSecretTargetIds } from "./command-secret-targets.js";

describe("MCP command secret target ids", () => {
  it("scopes MCP runtime validation to MCP credential targets", () => {
    expect(getMcpCommandSecretTargetIds()).toEqual(
      new Set(["mcp.servers.*.env.*", "mcp.servers.*.headers.*"]),
    );
  });
});
