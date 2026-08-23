import { describe, expect, it } from "vitest";
import { resolveConfigForRead } from "../config/io.read-helpers.js";
import { setConfigResolutionFacts } from "../config/resolution-facts.js";
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

  it("collects pending braced templates from source facts without reinterpreting literals", () => {
    const read = resolveConfigForRead(
      {
        mcp: {
          servers: {
            local: {
              command: "example-mcp",
              env: {
                BRACED: "${MISSING_LOCAL_TOKEN}",
                BARE: "$MISSING_LOCAL_LITERAL",
                ESCAPED: "$${MISSING_LOCAL_ESCAPED}",
              },
            },
            remote: {
              url: "https://mcp.example.test",
              headers: {
                "X-Braced": "${MISSING_REMOTE_TOKEN}",
                "X-Bare": "$MISSING_REMOTE_LITERAL",
                "X-Escaped": "$${MISSING_REMOTE_ESCAPED}",
              },
            },
          },
        },
      },
      {},
    );
    const config = read.resolvedConfigRaw as OpenClawConfig;
    setConfigResolutionFacts(config, read.resolutionFacts);

    const context = collect(config);

    expect(context.assignments.map((entry) => entry.path)).toEqual([
      "mcp.servers.local.env.BRACED",
      "mcp.servers.remote.headers.X-Braced",
    ]);
    expect(config.mcp?.servers?.local?.env).toMatchObject({
      BRACED: "${MISSING_LOCAL_TOKEN}",
      BARE: "$MISSING_LOCAL_LITERAL",
      ESCAPED: "${MISSING_LOCAL_ESCAPED}",
    });
    expect(config.mcp?.servers?.remote?.headers).toMatchObject({
      "X-Braced": "${MISSING_REMOTE_TOKEN}",
      "X-Bare": "$MISSING_REMOTE_LITERAL",
      "X-Escaped": "${MISSING_REMOTE_ESCAPED}",
    });
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

  it("does not resolve Authorization refs replaced by OAuth-managed transports", () => {
    const config = {
      mcp: {
        servers: {
          oauth: {
            url: "https://mcp.example.test/oauth",
            auth: "oauth",
            headers: {
              Authorization: ref("UNUSED_OAUTH_AUTHORIZATION"),
              "X-Tenant": ref("OAUTH_TENANT"),
            },
          },
          authProfile: {
            url: "https://mcp.example.test/profile",
            auth: "oauth",
            oauth: { authProfileId: "work" },
            headers: { authorization: ref("UNUSED_PROFILE_AUTHORIZATION") },
          },
        },
      },
    } as OpenClawConfig;

    const context = collect(config);

    expect(context.assignments.map((entry) => entry.path)).toEqual([
      "mcp.servers.oauth.headers.X-Tenant",
    ]);
    expect(context.warnings.map((entry) => entry.path)).toEqual([
      "mcp.servers.oauth.headers.Authorization",
      "mcp.servers.authProfile.headers.authorization",
    ]);
  });
});
