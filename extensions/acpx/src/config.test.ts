// ACPX tests cover config plugin behavior.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { buildPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import { AcpxPluginConfigSchema } from "./config-schema.js";
import { resolveAcpxPluginConfig, resolveAcpxPluginRoot, toAcpMcpServers } from "./config.js";

const requireFromTest = createRequire(import.meta.url);
const TSX_IMPORT = requireFromTest.resolve("tsx");
const pluginManifest = JSON.parse(
  fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
) as { configSchema: Record<string, unknown> };

function validateMcpServerEnvValue(value: unknown) {
  const config = { mcpServers: { proof: { command: "node", env: { TOKEN: value } } } };
  return {
    runtime: AcpxPluginConfigSchema.safeParse(config).success,
    manifest: validateJsonSchemaValue({
      schema: pluginManifest.configSchema,
      cacheKey: "acpx.manifest.config-schema",
      value: config,
    }).ok,
  };
}

function expectedMcpServerArgs(params: { sourceEntry: string; distEntry: string }): string[] {
  const distEntry = path.resolve(params.distEntry);
  if (fs.existsSync(distEntry)) {
    return [distEntry];
  }
  return ["--import", TSX_IMPORT, path.resolve(params.sourceEntry)];
}

describe("embedded acpx plugin config", () => {
  it.each([
    ["literal", "literal-token"],
    ["env", { source: "env", provider: "default", id: "MCP_TOKEN" }],
    ["file", { source: "file", provider: "vault", id: "/mcp/token" }],
    ["exec", { source: "exec", provider: "vault", id: "mcp/token" }],
    ["store", { source: "store", provider: "default", id: "MCP_TOKEN" }],
  ])("accepts %s MCP server env SecretInput in both production validators", (_source, value) => {
    expect(validateMcpServerEnvValue(value)).toEqual({ runtime: true, manifest: true });
  });

  it.each([
    ["missing provider", { source: "env", id: "MCP_TOKEN" }],
    ["missing id", { source: "env", provider: "default" }],
    ["unknown source", { source: "unknown", provider: "default", id: "MCP_TOKEN" }],
    ["unexpected field", { source: "env", provider: "default", id: "MCP_TOKEN", extra: true }],
    ["invalid provider", { source: "env", provider: "INVALID", id: "MCP_TOKEN" }],
    ["invalid env id", { source: "env", provider: "default", id: "lowercase" }],
  ])("rejects malformed MCP server env SecretInput with %s", (_reason, value) => {
    expect(validateMcpServerEnvValue(value)).toEqual({ runtime: false, manifest: false });
  });

  it("passes materialized MCP environment strings to ACP without changing them", () => {
    expect(
      toAcpMcpServers({
        proof: {
          command: "node",
          env: {
            LITERAL: "literal-token",
            RESOLVED: "materialized-secret-value",
            BARE_SHAPED: "$MCP_TOKEN",
            BRACED_SHAPED: "${MCP_TOKEN}",
            PADDED: "  token  ",
            EMPTY: "",
          },
        },
      }),
    ).toEqual([
      {
        name: "proof",
        command: "node",
        args: [],
        env: [
          { name: "LITERAL", value: "literal-token" },
          { name: "RESOLVED", value: "materialized-secret-value" },
          { name: "BARE_SHAPED", value: "$MCP_TOKEN" },
          { name: "BRACED_SHAPED", value: "${MCP_TOKEN}" },
          { name: "PADDED", value: "  token  " },
          { name: "EMPTY", value: "" },
        ],
      },
    ]);
  });

  it("rejects unresolved structured MCP environment references at the ACP boundary", () => {
    expect(() =>
      toAcpMcpServers({
        proof: {
          command: "node",
          env: { TOKEN: { source: "env", provider: "default", id: "MCP_TOKEN" } },
        },
      }),
    ).toThrow(
      expect.objectContaining({
        name: "UnresolvedSecretInputError",
        path: "plugins.entries.acpx.config.mcpServers.proof.env.TOKEN",
      }),
    );
  });

  it("resolves workspace stateDir and cwd by default", () => {
    const workspaceDir = path.resolve("/tmp/openclaw-acpx");
    const resolved = resolveAcpxPluginConfig({
      rawConfig: undefined,
      workspaceDir,
    });

    expect(resolved.cwd).toBe(workspaceDir);
    expect(resolved.stateDir).toBe(path.join(workspaceDir, "state"));
    expect(resolved.permissionMode).toBe("approve-reads");
    expect(resolved.nonInteractivePermissions).toBe("fail");
    expect(resolved.timeoutSeconds).toBe(120);
    expect(resolved.probeAgent).toBeUndefined();
    expect(resolved.agents).toStrictEqual({});
  });

  it("keeps explicit timeoutSeconds config", () => {
    const resolved = resolveAcpxPluginConfig({
      rawConfig: {
        timeoutSeconds: 300,
      },
      workspaceDir: "/tmp/openclaw-acpx",
    });

    expect(resolved.timeoutSeconds).toBe(300);
  });

  it("accepts agent command overrides", () => {
    const resolved = resolveAcpxPluginConfig({
      rawConfig: {
        agents: {
          claude: { command: "claude --acp" },
          codex: { command: "codex custom-acp" },
        },
      },
      workspaceDir: "/tmp/openclaw-acpx",
    });

    expect(resolved.agents).toEqual({
      claude: "claude --acp",
      codex: "codex custom-acp",
    });
  });

  it("combines agent command with args array", () => {
    const resolved = resolveAcpxPluginConfig({
      rawConfig: {
        agents: {
          claude: {
            command: "node",
            args: ["/path/to/adapter.mjs", "--verbose"],
          },
          codex: {
            command: "codex-acp",
            args: ["--model", "gpt-5"],
          },
        },
      },
      workspaceDir: "/tmp/openclaw-acpx",
    });

    expect(resolved.agents).toEqual({
      claude: "node /path/to/adapter.mjs --verbose",
      codex: "codex-acp --model gpt-5",
    });
  });

  it("quotes agent args that need to survive command-line parsing as one token", () => {
    const resolved = resolveAcpxPluginConfig({
      rawConfig: {
        agents: {
          custom: {
            command: "node",
            args: ["/tmp/My Adapter.mjs", "--flag=value with spaces", "owner's-choice"],
          },
        },
      },
      workspaceDir: "/tmp/openclaw-acpx",
    });

    expect(resolved.agents).toEqual({
      custom: "node '/tmp/My Adapter.mjs' '--flag=value with spaces' 'owner'\"'\"'s-choice'",
    });
  });

  it("handles agent command without args (backward compat)", () => {
    const resolved = resolveAcpxPluginConfig({
      rawConfig: {
        agents: {
          simple: { command: "simple-acp" },
        },
      },
      workspaceDir: "/tmp/openclaw-acpx",
    });

    expect(resolved.agents).toEqual({
      simple: "simple-acp",
    });
  });

  it("carries an explicit probeAgent through to the resolved plugin config, trimmed", () => {
    const resolved = resolveAcpxPluginConfig({
      rawConfig: {
        probeAgent: "  OpenCode  ",
      },
      workspaceDir: "/tmp/openclaw-acpx",
    });

    expect(resolved.probeAgent).toBe("OpenCode");
  });

  it("rejects an empty probeAgent string", () => {
    expect(() =>
      resolveAcpxPluginConfig({
        rawConfig: {
          probeAgent: "",
        },
        workspaceDir: "/tmp/openclaw-acpx",
      }),
    ).toThrow(/probeAgent must be a non-empty string/);
  });

  it("injects the built-in plugin-tools MCP server only when explicitly enabled", () => {
    const resolved = resolveAcpxPluginConfig({
      rawConfig: {
        pluginToolsMcpBridge: true,
      },
      workspaceDir: "/tmp/openclaw-acpx",
    });

    const server = resolved.mcpServers["openclaw-plugin-tools"];
    expect(server).toEqual({
      command: process.execPath,
      args: expectedMcpServerArgs({
        sourceEntry: "src/mcp/plugin-tools-serve.ts",
        distEntry: "dist/mcp/plugin-tools-serve.js",
      }),
    });
  });

  it("injects the built-in OpenClaw tools MCP server only when explicitly enabled", () => {
    const resolved = resolveAcpxPluginConfig({
      rawConfig: {
        openClawToolsMcpBridge: true,
      },
      workspaceDir: "/tmp/openclaw-acpx",
    });

    const server = resolved.mcpServers["openclaw-tools"];
    expect(server).toEqual({
      command: process.execPath,
      args: expectedMcpServerArgs({
        sourceEntry: "src/mcp/openclaw-tools-serve.ts",
        distEntry: "dist/mcp/openclaw-tools-serve.js",
      }),
    });
  });

  it("resolves the plugin root from shared dist chunk paths", () => {
    const moduleUrl = new URL("../../../dist/extensions/acpx/service-shared.js", import.meta.url)
      .href;

    expect(resolveAcpxPluginRoot(moduleUrl)).toBe(path.resolve("extensions/acpx"));
  });

  it("keeps the runtime json schema in sync with the manifest config schema", () => {
    expect(buildPluginConfigSchema(AcpxPluginConfigSchema).jsonSchema).toEqual(
      pluginManifest.configSchema,
    );
  });
});
