import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { collectCoreConfigAssignments } from "./runtime-config-collectors-core.js";
import { createResolverContext } from "./runtime-shared.js";

const ref = (id: string) => ({ source: "env", provider: "default", id }) as const;

function collect(config: OpenClawConfig) {
  const context = createResolverContext({ sourceConfig: config, env: {} });
  collectCoreConfigAssignments({ config, defaults: undefined, context });
  return context;
}

describe("core MCP SecretRef collection", () => {
  it("collects only the selected transport and preserves literal shorthand strings", () => {
    const config = {
      mcp: {
        servers: {
          local: {
            command: "example-mcp",
            env: { API_TOKEN: ref("MCP_TOKEN"), LITERAL: "$UNCHANGED" },
            headers: { Authorization: ref("UNUSED_HEADER") },
          },
        },
      },
    } as OpenClawConfig;

    const context = collect(config);

    expect(context.assignments.map((entry) => entry.path)).toEqual([
      "mcp.servers.local.env.API_TOKEN",
    ]);
    expect(context.warnings.map((entry) => entry.path)).toEqual([
      "mcp.servers.local.headers.Authorization",
    ]);
    expect(config.mcp?.servers?.local?.env?.LITERAL).toBe("$UNCHANGED");
  });

  it("does not resolve refs for disabled servers or blocked stdio env keys", () => {
    const config = {
      mcp: {
        servers: {
          disabled: {
            enabled: false,
            command: "example-mcp",
            env: { API_TOKEN: ref("DISABLED_TOKEN") },
          },
          blocked: {
            command: "example-mcp",
            env: { NODE_OPTIONS: ref("BLOCKED_NODE_OPTIONS") },
          },
        },
      },
    } as OpenClawConfig;

    const context = collect(config);

    expect(context.assignments).toEqual([]);
    expect(context.warnings.map((entry) => entry.path)).toEqual([
      "mcp.servers.disabled.env.API_TOKEN",
      "mcp.servers.blocked.env.NODE_OPTIONS",
    ]);
  });

  it("collects HTTP headers but not stdio env refs for remote servers", () => {
    const config = {
      mcp: {
        servers: {
          remote: {
            url: "https://mcp.example.test",
            headers: { Authorization: ref("MCP_AUTH") },
            env: { API_TOKEN: ref("UNUSED_ENV") },
          },
        },
      },
    } as OpenClawConfig;

    const context = collect(config);

    expect(context.assignments.map((entry) => entry.path)).toEqual([
      "mcp.servers.remote.headers.Authorization",
    ]);
    expect(context.warnings.map((entry) => entry.path)).toEqual([
      "mcp.servers.remote.env.API_TOKEN",
    ]);
  });
});
