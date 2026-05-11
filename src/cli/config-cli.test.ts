import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.js";
import { createCliRuntimeCapture, mockRuntimeModule } from "./test-runtime-capture.js";

/**
 * Test for issue #6070:
 * `openclaw config set/unset` must update snapshot.resolved (user config after $include/${ENV},
 * but before runtime defaults), so runtime defaults don't leak into the written config.
 */

const mockReadConfigFileSnapshot = vi.fn<() => Promise<ConfigFileSnapshot>>();
const mockWriteConfigFile = vi.fn<
  (
    cfg: OpenClawConfig,
    options?: { unsetPaths?: string[][]; explicitSetPaths?: string[][] },
  ) => Promise<void>
>(async () => {});
const mockResolveSecretRefValue = vi.fn();
const mockReadBestEffortRuntimeConfigSchema = vi.fn();

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    readConfigFileSnapshot: () => mockReadConfigFileSnapshot(),
    writeConfigFile: (
      cfg: OpenClawConfig,
      options?: { unsetPaths?: string[][]; explicitSetPaths?: string[][] },
    ) => mockWriteConfigFile(cfg, options),
    replaceConfigFile: (params: {
      nextConfig: OpenClawConfig;
      writeOptions?: { unsetPaths?: string[][]; explicitSetPaths?: string[][] };
    }) => mockWriteConfigFile(params.nextConfig, params.writeOptions),
  };
});

vi.mock("../secrets/resolve.js", () => ({
  resolveSecretRefValue: (...args: unknown[]) => mockResolveSecretRefValue(...args),
}));

vi.mock("../config/runtime-schema.js", () => ({
  readBestEffortRuntimeConfigSchema: () => mockReadBestEffortRuntimeConfigSchema(),
}));

const { defaultRuntime, resetRuntimeCapture } = createCliRuntimeCapture();
const mockLog = defaultRuntime.log;
const mockError = defaultRuntime.error;
const mockExit = defaultRuntime.exit;

vi.mock("../runtime.js", async () => {
  return mockRuntimeModule(
    () => vi.importActual<typeof import("../runtime.js")>("../runtime.js"),
    defaultRuntime,
  );
});

function buildSnapshot(params: {
  resolved: OpenClawConfig;
  config: OpenClawConfig;
}): ConfigFileSnapshot {
  return {
    path: "/tmp/openclaw.json",
    exists: true,
    raw: JSON.stringify(params.resolved),
    parsed: params.resolved,
    sourceConfig: params.resolved,
    resolved: params.resolved,
    valid: true,
    runtimeConfig: params.config,
    config: params.config,
    issues: [],
    warnings: [],
    legacyIssues: [],
  };
}

function setSnapshot(resolved: OpenClawConfig, config: OpenClawConfig) {
  mockReadConfigFileSnapshot.mockResolvedValueOnce(buildSnapshot({ resolved, config }));
}

function setSnapshotOnce(snapshot: ConfigFileSnapshot) {
  mockReadConfigFileSnapshot.mockResolvedValueOnce(snapshot);
}

function writeTempJson5File(prefix: string, value: unknown): string {
  const pathname = path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}.json5`,
  );
  fs.writeFileSync(pathname, JSON.stringify(value), "utf8");
  return pathname;
}

function withRuntimeDefaults(resolved: OpenClawConfig): OpenClawConfig {
  return {
    ...resolved,
    agents: {
      ...resolved.agents,
      defaults: {
        model: "gpt-5.4",
      } as never,
    } as never,
  };
}

function makeInvalidSnapshot(params: {
  issues: ConfigFileSnapshot["issues"];
  path?: string;
}): ConfigFileSnapshot {
  return {
    path: params.path ?? "/tmp/custom-openclaw.json",
    exists: true,
    raw: "{}",
    parsed: {},
    sourceConfig: {},
    resolved: {},
    valid: false,
    runtimeConfig: {},
    config: {},
    issues: params.issues,
    warnings: [],
    legacyIssues: [],
  };
}

async function runValidateJsonAndGetPayload() {
  await expect(runConfigCommand(["config", "validate", "--json"])).rejects.toThrow("__exit__:1");
  const raw = mockLog.mock.calls.at(0)?.[0];
  expect(typeof raw).toBe("string");
  return JSON.parse(String(raw)) as {
    valid: boolean;
    path: string;
    issues: Array<{
      path: string;
      message: string;
      allowedValues?: string[];
      allowedValuesHiddenCount?: number;
    }>;
  };
}

function requireWriteOptions(): { unsetPaths?: string[][]; explicitSetPaths?: string[][] } {
  const options = mockWriteConfigFile.mock.calls[0]?.[1];
  if (!options) {
    throw new Error("expected write options");
  }
  return options;
}

function expectLogIncludes(text: string) {
  expect(mockLog.mock.calls.some((call) => String(call[0]).includes(text))).toBe(true);
}

function expectLogExcludes(text: string) {
  expect(mockLog.mock.calls.some((call) => String(call[0]).includes(text))).toBe(false);
}

function expectErrorIncludes(text: string) {
  expect(mockError.mock.calls.some((call) => String(call[0]).includes(text))).toBe(true);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

function requireResolveSecretRefCall(index: number): [unknown, unknown] {
  const call = mockResolveSecretRefValue.mock.calls[index];
  if (!call) {
    throw new Error(`expected SecretRef resolver call ${index}`);
  }
  return call as [unknown, unknown];
}

let registerConfigCli: typeof import("./config-cli.js").registerConfigCli;
let sharedProgram: Command;

async function runConfigCommand(args: string[]) {
  await sharedProgram.parseAsync(args, { from: "user" });
}

describe("config cli", () => {
  beforeAll(async () => {
    ({ registerConfigCli } = await import("./config-cli.js"));
    sharedProgram = new Command();
    sharedProgram.exitOverride();
    registerConfigCli(sharedProgram);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetRuntimeCapture();
    mockReadBestEffortRuntimeConfigSchema.mockResolvedValue({
      schema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {
          channels: {
            type: "object",
            properties: {
              telegram: {
                type: "object",
                properties: {
                  token: { type: "string" },
                },
              },
            },
          },
          plugins: {
            type: "object",
            properties: {
              entries: {
                type: "object",
              },
            },
          },
        },
      },
      uiHints: {},
      version: "test",
      generatedAt: "2026-03-25T00:00:00.000Z",
    });
    mockExit.mockImplementation((code: number) => {
      const errorMessages = mockError.mock.calls.map((call) => call.join(" ")).join("; ");
      throw new Error(`__exit__:${code} - ${errorMessages}`);
    });
    mockResolveSecretRefValue.mockResolvedValue("resolved-secret");
  });

  describe("config set - issue #6070", () => {
    it("preserves existing config keys when setting a new value", async () => {
      const resolved: OpenClawConfig = {
        agents: {
          list: [{ id: "main" }, { id: "oracle", workspace: "~/oracle-workspace" }],
        },
        gateway: { port: 18789 },
        tools: { allow: ["group:fs"] },
        logging: { level: "debug" },
      };
      const runtimeMerged: OpenClawConfig = {
        ...withRuntimeDefaults(resolved),
      };
      setSnapshot(resolved, runtimeMerged);

      await runConfigCommand(["config", "set", "gateway.auth.mode", "token"]);

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const written = mockWriteConfigFile.mock.calls[0]?.[0];
      expect(written.gateway?.auth).toEqual({ mode: "token" });
      expect(written.gateway?.port).toBe(18789);
      expect(written.agents).toEqual(resolved.agents);
      expect(written.tools).toEqual(resolved.tools);
      expect(written.logging).toEqual(resolved.logging);
      expect(written.agents).not.toHaveProperty("defaults");
    });

    it("marks set paths explicit so default-equal writes persist", async () => {
      const resolved: OpenClawConfig = {
        channels: {
          telegram: {
            botToken: "tok-abc",
          },
        },
      };
      const runtimeMerged = {
        ...resolved,
        channels: {
          telegram: {
            botToken: "tok-abc",
            dmPolicy: "pairing",
          },
        },
      } as OpenClawConfig;
      setSnapshot(resolved, runtimeMerged);

      await runConfigCommand(["config", "set", "channels.telegram.dmPolicy", "pairing"]);

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      expect(requireWriteOptions().explicitSetPaths).toEqual([
        ["channels", "telegram", "dmPolicy"],
      ]);
    });

    it("marks object set paths explicit so nested default-equal writes persist", async () => {
      const resolved: OpenClawConfig = {
        channels: {
          telegram: {
            botToken: "tok-abc",
          },
        },
      };
      const runtimeMerged = {
        ...resolved,
        channels: {
          telegram: {
            botToken: "tok-abc",
            dmPolicy: "pairing",
          },
        },
      } as OpenClawConfig;
      setSnapshot(resolved, runtimeMerged);

      await runConfigCommand([
        "config",
        "set",
        "channels.telegram",
        '{"botToken":"tok-abc","dmPolicy":"pairing"}',
        "--strict-json",
      ]);

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      expect(requireWriteOptions().explicitSetPaths).toEqual([["channels", "telegram"]]);
    });

    it("does not inject runtime defaults into the written config", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
      };
      const runtimeMerged = {
        ...resolved,
        agents: {
          defaults: {
            model: "gpt-5.4",
            contextWindow: 128_000,
            maxTokens: 16_000,
          },
        } as never,
        messages: { ackReaction: "✅" } as never,
        sessions: { persistence: { enabled: true } } as never,
      } as unknown as OpenClawConfig;
      setSnapshot(resolved, runtimeMerged);

      await runConfigCommand(["config", "set", "gateway.auth.mode", "token"]);

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const written = mockWriteConfigFile.mock.calls[0]?.[0];
      expect(written).not.toHaveProperty("agents.defaults.model");
      expect(written).not.toHaveProperty("agents.defaults.contextWindow");
      expect(written).not.toHaveProperty("agents.defaults.maxTokens");
      expect(written).not.toHaveProperty("messages.ackReaction");
      expect(written).not.toHaveProperty("sessions.persistence");
      expect(written.gateway?.port).toBe(18789);
      expect(written.gateway?.auth).toEqual({ mode: "token" });
    });

    it("writes agents.defaults.videoGenerationModel.primary without disturbing sibling defaults", async () => {
      const resolved: OpenClawConfig = {
        agents: {
          defaults: {
            model: "openai/gpt-5.4",
            imageGenerationModel: {
              primary: "openai/gpt-image-1",
            },
          },
        },
      };
      setSnapshot(resolved, resolved);

      await runConfigCommand([
        "config",
        "set",
        "agents.defaults.videoGenerationModel.primary",
        "qwen/wan2.6-t2v",
      ]);

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const written = mockWriteConfigFile.mock.calls[0]?.[0];
      expect(written.agents?.defaults?.model).toBe("openai/gpt-5.4");
      expect(written.agents?.defaults?.imageGenerationModel).toEqual({
        primary: "openai/gpt-image-1",
      });
      expect(written.agents?.defaults?.videoGenerationModel).toEqual({
        primary: "qwen/wan2.6-t2v",
      });
    });

    it("normalizes retired Google Gemini model refs before writing config mutations", async () => {
      const resolved: OpenClawConfig = {
        agents: {
          defaults: {
            model: {
              fallbacks: ["google/gemini-3-pro-preview"],
            },
            models: {
              "google/gemini-3-pro-preview": { alias: "gemini" },
            },
          },
        },
      };
      setSnapshot(resolved, resolved);

      await runConfigCommand([
        "config",
        "set",
        "agents.defaults.model.primary",
        "google/gemini-3-pro-preview",
      ]);

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const written = mockWriteConfigFile.mock.calls[0]?.[0];
      expect(written.agents?.defaults?.model).toEqual({
        primary: "google/gemini-3.1-pro-preview",
        fallbacks: ["google/gemini-3.1-pro-preview"],
      });
      expect(written.agents?.defaults?.models).toEqual({
        "google/gemini-3.1-pro-preview": { alias: "gemini" },
      });
    });

    it("normalizes explicit model-map paths before writing config mutations", async () => {
      const resolved: OpenClawConfig = {
        agents: {
          defaults: {
            models: {
              "google/gemini-3-pro-preview": {},
            },
          },
        },
      };
      setSnapshot(resolved, resolved);

      await runConfigCommand([
        "config",
        "set",
        "agents.defaults.models.google/gemini-3-pro-preview.alias",
        "gemini",
      ]);

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const written = mockWriteConfigFile.mock.calls[0]?.[0];
      expect(written.agents?.defaults?.models).toEqual({
        "google/gemini-3.1-pro-preview": { alias: "gemini" },
      });
      expect(requireWriteOptions().explicitSetPaths).toEqual([
        ["agents", "defaults", "models", "google/gemini-3.1-pro-preview", "alias"],
      ]);
    });

    it("rejects plugin install record config updates", async () => {
      await expect(
        runConfigCommand([
          "config",
          "set",
          'plugins.installs["openclaw-web-search"].spec',
          '"@ollama/openclaw-web-search@0.2.2"',
          "--strict-json",
          "--dry-run",
        ]),
      ).rejects.toThrow("__exit__:1");

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expectErrorIncludes("openclaw plugins install <spec>");
      expectErrorIncludes("openclaw plugins update <plugin-id>");
    });

    it("rejects protected model map replacement unless explicitly requested", async () => {
      const resolved: OpenClawConfig = {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": { alias: "GPT" },
              "anthropic/claude-sonnet-4-6": { alias: "Sonnet" },
            },
          },
        },
      };
      setSnapshot(resolved, resolved);

      await expect(
        runConfigCommand([
          "config",
          "set",
          "agents.defaults.models",
          '{"openai/gpt-5.4":{}}',
          "--strict-json",
        ]),
      ).rejects.toThrow("__exit__:1");

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expectErrorIncludes("Refusing to replace agents.defaults.models");
    });

    it("merges protected model map values with --merge", async () => {
      const resolved: OpenClawConfig = {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": { alias: "GPT" },
            },
          },
        },
      };
      setSnapshot(resolved, resolved);

      await runConfigCommand([
        "config",
        "set",
        "agents.defaults.models",
        '{"anthropic/claude-sonnet-4-6":{"alias":"Sonnet"}}',
        "--strict-json",
        "--merge",
      ]);

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const written = mockWriteConfigFile.mock.calls[0]?.[0];
      expect(written.agents?.defaults?.models).toEqual({
        "openai/gpt-5.4": { alias: "GPT" },
        "anthropic/claude-sonnet-4-6": { alias: "Sonnet" },
      });
    });

    it("merges provider model arrays by id with --merge", async () => {
      const resolved = {
        models: {
          providers: {
            ollama: {
              api: "ollama",
              models: [
                { id: "llama3.2", name: "Llama 3.2", contextWindow: 131072 },
                { id: "qwen3", name: "Qwen 3" },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig;
      setSnapshot(resolved, resolved);

      await runConfigCommand([
        "config",
        "set",
        "models.providers.ollama.models",
        '[{"id":"llama3.2","name":"Llama 3.2 latest"},{"id":"gemma4","name":"Gemma 4"}]',
        "--strict-json",
        "--merge",
      ]);

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const written = mockWriteConfigFile.mock.calls[0]?.[0];
      expect(written.models?.providers?.ollama?.models).toEqual([
        { id: "llama3.2", name: "Llama 3.2 latest", contextWindow: 131072 },
        { id: "qwen3", name: "Qwen 3" },
        { id: "gemma4", name: "Gemma 4" },
      ]);
    });

    it("drops gateway.auth.password when switching mode to token", async () => {
      const resolved: OpenClawConfig = {
        gateway: {
          auth: {
            mode: "password",
            token: "token-keep",
            password: "password-drop", // pragma: allowlist secret
            allowTailscale: true,
          },
        },
      };
      setSnapshot(resolved, resolved);

      await runConfigCommand(["config", "set", "gateway.auth.mode", "token"]);

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const written = mockWriteConfigFile.mock.calls[0]?.[0];
      expect(written.gateway?.auth).toEqual({
        mode: "token",
        token: "token-keep",
        allowTailscale: true,
      });
      expectLogIncludes("Removed inactive gateway.auth.password for gateway.auth.mode=token");
    });

    it("drops gateway.auth.token when switching mode to password", async () => {
      const resolved: OpenClawConfig = {
        gateway: {
          auth: {
            mode: "token",
            token: "token-drop",
            password: "password-keep", // pragma: allowlist secret
          },
        },
      };
      setSnapshot(resolved, resolved);

      await runConfigCommand(["config", "set", "gateway.auth.mode", "password"]);

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const written = mockWriteConfigFile.mock.calls[0]?.[0];
      expect(written.gateway?.auth).toEqual({
        mode: "password",
        password: "password-keep", // pragma: allowlist secret
      });
      expectLogIncludes("Removed inactive gateway.auth.token for gateway.auth.mode=password");
    });

    it("applies mode-based credential cleanup using the final batch result", async () => {
      const resolved: OpenClawConfig = {
        gateway: {
          auth: {
            mode: "password",
            token: "token-keep",
            password: "password-drop", // pragma: allowlist secret
          },
        },
      };
      setSnapshot(resolved, resolved);

      await runConfigCommand([
        "config",
        "set",
        "--batch-json",
        '[{"path":"gateway.auth.password","value":"password-updated"},{"path":"gateway.auth.mode","value":"token"}]',
      ]);

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const written = mockWriteConfigFile.mock.calls[0]?.[0];
      expect(written.gateway?.auth).toEqual({
        mode: "token",
        token: "token-keep",
      });
      expectLogIncludes("Removed inactive gateway.auth.password for gateway.auth.mode=token");
    });
  });

  describe("config get", () => {
    it("redacts sensitive values", async () => {
      const resolved: OpenClawConfig = {
        gateway: {
          auth: {
            token: "super-secret-token",
          },
        },
      };
      setSnapshot(resolved, resolved);

      await runConfigCommand(["config", "get", "gateway.auth.token"]);

      expect(mockLog).toHaveBeenCalledWith("__OPENCLAW_REDACTED__");
    });
  });

  describe("config validate", () => {
    it("prints success and exits 0 when config is valid", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
      };
      setSnapshot(resolved, resolved);

      await runConfigCommand(["config", "validate"]);

      expect(mockExit).not.toHaveBeenCalled();
      expect(mockError).not.toHaveBeenCalled();
      expectLogIncludes("Config valid:");
    });

    it("prints issues and exits 1 when config is invalid", async () => {
      setSnapshotOnce(
        makeInvalidSnapshot({
          issues: [
            {
              path: "agents.defaults.suppressToolErrorWarnings",
              message: "Unrecognized key(s) in object",
            },
          ],
        }),
      );

      await expect(runConfigCommand(["config", "validate"])).rejects.toThrow("__exit__:1");

      expectErrorIncludes("config is invalid");
      expectErrorIncludes("agents.defaults.suppressToolErrorWarnings");
      expect(mockLog).not.toHaveBeenCalled();
    });

    it("returns machine-readable JSON with --json for invalid config", async () => {
      setSnapshotOnce(
        makeInvalidSnapshot({
          issues: [{ path: "gateway.bind", message: "Invalid enum value" }],
        }),
      );

      const payload = await runValidateJsonAndGetPayload();
      expect(payload.valid).toBe(false);
      expect(payload.path).toBe("/tmp/custom-openclaw.json");
      expect(payload.issues).toEqual([{ path: "gateway.bind", message: "Invalid enum value" }]);
      expect(mockError).not.toHaveBeenCalled();
    });

    it("preserves allowed-values metadata in --json output", async () => {
      setSnapshotOnce(
        makeInvalidSnapshot({
          issues: [
            {
              path: "update.channel",
              message: 'Invalid input (allowed: "stable", "beta", "dev")',
              allowedValues: ["stable", "beta", "dev"],
              allowedValuesHiddenCount: 0,
            },
          ],
        }),
      );

      const payload = await runValidateJsonAndGetPayload();
      expect(payload.valid).toBe(false);
      expect(payload.path).toBe("/tmp/custom-openclaw.json");
      expect(payload.issues).toEqual([
        {
          path: "update.channel",
          message: 'Invalid input (allowed: "stable", "beta", "dev")',
          allowedValues: ["stable", "beta", "dev"],
        },
      ]);
      expect(mockError).not.toHaveBeenCalled();
    });

    it("prints file-not-found and exits 1 when config file is missing", async () => {
      setSnapshotOnce({
        path: "/tmp/openclaw.json",
        exists: false,
        raw: null,
        parsed: {},
        resolved: {},
        sourceConfig: {},
        valid: true,
        config: {},
        runtimeConfig: {},
        issues: [],
        warnings: [],
        legacyIssues: [],
      });

      await expect(runConfigCommand(["config", "validate"])).rejects.toThrow("__exit__:1");
      expectErrorIncludes("Config file not found:");
      expect(mockLog).not.toHaveBeenCalled();
    });
  });

  describe("config schema", () => {
    it("prints the generated JSON schema as plain text", async () => {
      const { computeBaseConfigSchemaResponse } = await import("../config/schema-base.js");
      mockReadBestEffortRuntimeConfigSchema.mockResolvedValueOnce(
        computeBaseConfigSchemaResponse({
          generatedAt: "2026-03-25T00:00:00.000Z",
        }),
      );

      await runConfigCommand(["config", "schema"]);

      expect(mockExit).not.toHaveBeenCalled();
      expect(mockError).not.toHaveBeenCalled();
      expect(defaultRuntime.writeJson).toHaveBeenCalledTimes(1);
      const raw = mockLog.mock.calls.at(-1)?.[0];
      expect(typeof raw).toBe("string");
      const payload = JSON.parse(String(raw)) as {
        properties?: Record<string, unknown>;
      };
      const gateway = payload.properties?.gateway as
        | { properties?: Record<string, unknown> }
        | undefined;
      const gatewayPort = gateway?.properties?.port as
        | { title?: string; description?: string }
        | undefined;
      expect(payload.properties?.$schema).toEqual({ type: "string" });
      expect(gatewayPort?.title).toBe("Gateway Port");
      expect(gatewayPort?.description).toContain("TCP port used by the gateway listener");
      const channels = requireRecord(payload.properties?.channels, "schema channels");
      expect(channels.title).toBe("Channels");
      expect(channels.properties).toEqual({});
      expect(channels.additionalProperties).toBe(true);
      const plugins = requireRecord(payload.properties?.plugins, "schema plugins");
      expect(plugins.title).toBe("Plugins");
      expect(plugins.description).toContain("Plugin system controls");
      const pluginProperties = requireRecord(plugins.properties, "schema plugin properties");
      expect(requireRecord(pluginProperties.entries, "schema plugin entries").title).toBe(
        "Plugin Entries",
      );
    });

    it("falls back cleanly when best-effort schema loading returns channel-only data", async () => {
      mockReadBestEffortRuntimeConfigSchema.mockResolvedValueOnce({
        schema: {
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "object",
          properties: {
            channels: {
              type: "object",
              properties: {
                telegram: {
                  type: "object",
                },
              },
            },
          },
        },
        uiHints: {},
        version: "test",
        generatedAt: "2026-03-25T00:00:00.000Z",
      });

      await runConfigCommand(["config", "schema"]);

      expect(defaultRuntime.writeJson).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(String(mockLog.mock.calls.at(-1)?.[0])) as {
        properties?: Record<string, unknown>;
      };
      expect(payload.properties?.$schema).toEqual({ type: "string" });
      const channels = requireRecord(payload.properties?.channels, "schema channels");
      expect(channels.type).toBe("object");
      expect(channels.properties).toEqual({ telegram: { type: "object" } });
      expect(payload.properties?.plugins).toBeUndefined();
      expect(mockError).not.toHaveBeenCalled();
    });
  });

  describe("config set parsing flags", () => {
    it("falls back to raw string when parsing fails and strict mode is off", async () => {
      const resolved: OpenClawConfig = { gateway: { port: 18789 } };
      setSnapshot(resolved, resolved);

      await runConfigCommand(["config", "set", "gateway.auth.mode", "{bad"]);

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const written = mockWriteConfigFile.mock.calls[0]?.[0];
      expect(written.gateway?.auth).toEqual({ mode: "{bad" });
    });

    it("throws when strict parsing is enabled via --strict-json", async () => {
      await expect(
        runConfigCommand(["config", "set", "gateway.auth.mode", "{bad", "--strict-json"]),
      ).rejects.toThrow("__exit__:1");

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expect(mockReadConfigFileSnapshot).not.toHaveBeenCalled();
      expectErrorIncludes('Could not parse "{bad" as JSON for --strict-json.');
      expectErrorIncludes("For plain strings, omit --strict-json.");
    });

    it("keeps --json as a strict parsing alias", async () => {
      await expect(
        runConfigCommand(["config", "set", "gateway.auth.mode", "{bad", "--json"]),
      ).rejects.toThrow("__exit__:1");

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expect(mockReadConfigFileSnapshot).not.toHaveBeenCalled();
    });

    it("rejects JSON5-only object syntax when strict parsing is enabled", async () => {
      await expect(
        runConfigCommand(["config", "set", "gateway.auth", "{mode:'token'}", "--strict-json"]),
      ).rejects.toThrow("__exit__:1");

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expect(mockReadConfigFileSnapshot).not.toHaveBeenCalled();
    });

    it("accepts --strict-json with batch mode and applies batch payload", async () => {
      const resolved: OpenClawConfig = { gateway: { port: 18789 } };
      setSnapshot(resolved, resolved);

      await runConfigCommand([
        "config",
        "set",
        "--batch-json",
        '[{"path":"gateway.auth.mode","value":"token"}]',
        "--strict-json",
      ]);

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const written = mockWriteConfigFile.mock.calls[0]?.[0];
      expect(written.gateway?.auth).toEqual({ mode: "token" });
    });

    it("shows --strict-json and keeps --json as a legacy alias in help", () => {
      const program = new Command();
      registerConfigCli(program);

      const configCommand = program.commands.find((command) => command.name() === "config");
      const setCommand = configCommand?.commands.find((command) => command.name() === "set");
      const helpText = setCommand?.helpInformation() ?? "";
      const configHelpText = configCommand?.helpInformation() ?? "";

      expect(configHelpText).toContain("get/set/patch/unset/file/schema/validate");
      expect(configHelpText).not.toContain("get/set/apply/unset/file/schema/validate");
      expect(helpText).toContain("--strict-json");
      expect(helpText).toContain("--json");
      expect(helpText).toContain("Legacy alias for --strict-json");
      expect(helpText).toContain("Value (JSON/JSON5 or raw string)");
      expect(helpText).toContain("Strict JSON parsing (error instead of");
      expect(helpText).toContain("--ref-provider");
      expect(helpText).toContain("--provider-source");
      expect(helpText).toContain("--batch-json");
      expect(helpText).toContain("--dry-run");
      expect(helpText).toContain("--allow-exec");
      expect(helpText).toContain("openclaw config set gateway.port 19001 --strict-json");
      expect(helpText).toContain(
        "openclaw config set channels.discord.token --ref-provider default --ref-source",
      );
      expect(helpText).toContain("--ref-id DISCORD_BOT_TOKEN");
      expect(helpText).toContain(
        "openclaw config set --batch-file ./config-set.batch.json --dry-run",
      );
    });
  });

  describe("config set builders and dry-run", () => {
    it("supports SecretRef builder mode without requiring a value argument", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
      };
      setSnapshot(resolved, resolved);

      await runConfigCommand([
        "config",
        "set",
        "channels.discord.token",
        "--ref-provider",
        "default",
        "--ref-source",
        "env",
        "--ref-id",
        "DISCORD_BOT_TOKEN",
      ]);

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const written = mockWriteConfigFile.mock.calls[0]?.[0];
      expect(written.channels?.discord?.token).toEqual({
        source: "env",
        provider: "default",
        id: "DISCORD_BOT_TOKEN",
      });
    });

    it("fails early when unsupported mutable paths are assigned SecretRef objects (builder mode)", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
      };
      setSnapshot(resolved, resolved);

      await expect(
        runConfigCommand([
          "config",
          "set",
          "hooks.token",
          "--ref-provider",
          "default",
          "--ref-source",
          "env",
          "--ref-id",
          "HOOK_TOKEN",
        ]),
      ).rejects.toThrow("__exit__:1");

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expectErrorIncludes("Config policy validation failed: unsupported SecretRef usage");
      expectErrorIncludes("hooks.token");
    });

    it("fails early when parent-object writes include unsupported SecretRef objects", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
      };
      setSnapshot(resolved, resolved);

      await expect(
        runConfigCommand([
          "config",
          "set",
          "hooks",
          '{"token":{"source":"env","provider":"default","id":"HOOK_TOKEN"}}',
          "--strict-json",
        ]),
      ).rejects.toThrow("__exit__:1");

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expectErrorIncludes("Config policy validation failed: unsupported SecretRef usage");
      expectErrorIncludes("hooks.token");
    });

    it("supports provider builder mode under secrets.providers.<alias>", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
      };
      setSnapshot(resolved, resolved);

      await runConfigCommand([
        "config",
        "set",
        "secrets.providers.vaultfile",
        "--provider-source",
        "file",
        "--provider-path",
        "/tmp/vault.json",
        "--provider-mode",
        "json",
        "--provider-allow-insecure-path",
      ]);

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const written = mockWriteConfigFile.mock.calls[0]?.[0];
      expect(written.secrets?.providers?.vaultfile).toEqual({
        source: "file",
        path: "/tmp/vault.json",
        mode: "json",
        allowInsecurePath: true,
      });
    });

    it("runs resolvability checks in builder dry-run mode without writing", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      };
      setSnapshot(resolved, resolved);

      await runConfigCommand([
        "config",
        "set",
        "channels.discord.token",
        "--ref-provider",
        "default",
        "--ref-source",
        "env",
        "--ref-id",
        "DISCORD_BOT_TOKEN",
        "--dry-run",
      ]);

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expect(mockResolveSecretRefValue).toHaveBeenCalledTimes(1);
      const [secretRef, resolveOptions] = requireResolveSecretRefCall(0);
      expect(secretRef).toEqual({
        source: "env",
        provider: "default",
        id: "DISCORD_BOT_TOKEN",
      });
      expect(requireRecord(resolveOptions, "resolve options").env).toBeTypeOf("object");
    });

    it("requires schema validation in JSON dry-run mode", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
      };
      setSnapshot(resolved, resolved);

      await expect(
        runConfigCommand([
          "config",
          "set",
          "gateway.port",
          '"not-a-number"',
          "--strict-json",
          "--dry-run",
        ]),
      ).rejects.toThrow("__exit__:1");

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expectErrorIncludes("Dry run failed: config schema validation failed.");
    });

    it("fails dry-run when unsupported mutable paths receive SecretRef objects in value/json mode", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      };
      setSnapshot(resolved, resolved);

      await expect(
        runConfigCommand([
          "config",
          "set",
          "hooks.token",
          '{"source":"env","provider":"default","id":"HOOK_TOKEN"}',
          "--strict-json",
          "--dry-run",
        ]),
      ).rejects.toThrow("__exit__:1");

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expectErrorIncludes("Dry run failed: config schema validation failed.");
      expectErrorIncludes("hooks.token");
    });

    it("aggregates policy failures across batch entries", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
      };
      setSnapshot(resolved, resolved);

      await expect(
        runConfigCommand([
          "config",
          "set",
          "--batch-json",
          '[{"path":"hooks.token","ref":{"source":"env","provider":"default","id":"HOOK_TOKEN"}},{"path":"commands.ownerDisplaySecret","ref":{"source":"env","provider":"default","id":"OWNER_DISPLAY_SECRET"}}]',
          "--dry-run",
        ]),
      ).rejects.toThrow("__exit__:1");

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expectErrorIncludes("hooks.token");
      expectErrorIncludes("commands.ownerDisplaySecret");
    });

    it("does not duplicate policy errors in --dry-run --json mode for parent-object writes", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
      };
      setSnapshot(resolved, resolved);

      await expect(
        runConfigCommand([
          "config",
          "set",
          "hooks",
          '{"token":{"source":"env","provider":"default","id":"HOOK_TOKEN"}}',
          "--strict-json",
          "--dry-run",
          "--json",
        ]),
      ).rejects.toThrow("__exit__:1");

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      const raw = mockLog.mock.calls.at(-1)?.[0];
      expect(typeof raw).toBe("string");
      const payload = JSON.parse(String(raw)) as {
        ok: boolean;
        checks: { schema: boolean; resolvability: boolean; resolvabilityComplete: boolean };
        errors?: Array<{ kind: string; message: string; ref?: string }>;
      };
      expect(payload.ok).toBe(false);
      expect(payload.checks.schema).toBe(true);
      const hooksTokenErrors =
        payload.errors?.filter(
          (entry) => entry.kind === "schema" && entry.message.includes("hooks.token"),
        ) ?? [];
      expect(hooksTokenErrors).toHaveLength(1);
    });

    it("logs a dry-run note when value mode performs no validation checks", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
      };
      setSnapshot(resolved, resolved);

      await runConfigCommand(["config", "set", "gateway.port", "19001", "--dry-run"]);

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expect(mockResolveSecretRefValue).not.toHaveBeenCalled();
      expectLogIncludes("Dry run note: value mode does not run schema/resolvability checks.");
      expectLogIncludes("Dry run successful: 1 update(s) validated");
    });

    it("supports batch mode for refs/providers in dry-run", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      };
      setSnapshot(resolved, resolved);

      await runConfigCommand([
        "config",
        "set",
        "--batch-json",
        '[{"path":"channels.discord.token","ref":{"source":"env","provider":"default","id":"DISCORD_BOT_TOKEN"}},{"path":"secrets.providers.default","provider":{"source":"env"}}]',
        "--dry-run",
      ]);

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expect(mockResolveSecretRefValue).toHaveBeenCalledTimes(1);
    });

    it("skips exec SecretRef resolvability checks in dry-run by default", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
        secrets: {
          providers: {
            runner: {
              source: "exec",
              command: "/usr/bin/env",
              allowInsecurePath: true,
            },
          },
        },
      };
      setSnapshot(resolved, resolved);

      await runConfigCommand([
        "config",
        "set",
        "channels.discord.token",
        "--ref-provider",
        "runner",
        "--ref-source",
        "exec",
        "--ref-id",
        "openai",
        "--dry-run",
      ]);

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expect(mockResolveSecretRefValue).not.toHaveBeenCalled();
      expectLogIncludes(
        "Dry run note: skipped 1 exec SecretRef resolvability check(s). Re-run with --allow-exec",
      );
    });

    it("allows exec SecretRef resolvability checks in dry-run when --allow-exec is set", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
        secrets: {
          providers: {
            runner: {
              source: "exec",
              command: "/usr/bin/env",
              allowInsecurePath: true,
            },
          },
        },
      };
      setSnapshot(resolved, resolved);

      await runConfigCommand([
        "config",
        "set",
        "channels.discord.token",
        "--ref-provider",
        "runner",
        "--ref-source",
        "exec",
        "--ref-id",
        "openai",
        "--dry-run",
        "--allow-exec",
      ]);

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expect(mockResolveSecretRefValue).toHaveBeenCalledTimes(1);
      const [secretRef, resolveOptions] = requireResolveSecretRefCall(0);
      const secretRefRecord = requireRecord(secretRef, "exec SecretRef");
      expect(secretRefRecord.source).toBe("exec");
      expect(secretRefRecord.provider).toBe("runner");
      expect(secretRefRecord.id).toBe("openai");
      expect(resolveOptions).toBeTypeOf("object");
      expectLogExcludes("Dry run note: skipped 1 exec SecretRef resolvability check(s).");
    });

    it("rejects --allow-exec without --dry-run", async () => {
      const nonexistentBatchPath = path.join(
        os.tmpdir(),
        `openclaw-config-batch-nonexistent-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
      );
      await expect(
        runConfigCommand(["config", "set", "--batch-file", nonexistentBatchPath, "--allow-exec"]),
      ).rejects.toThrow("__exit__:1");

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expect(mockResolveSecretRefValue).not.toHaveBeenCalled();
      expectErrorIncludes("config set mode error: --allow-exec requires --dry-run.");
    });

    it("fails dry-run when skipped exec refs use an unconfigured provider", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
        secrets: {
          providers: {},
        },
      };
      setSnapshot(resolved, resolved);

      await expect(
        runConfigCommand([
          "config",
          "set",
          "channels.discord.token",
          "--ref-provider",
          "runner",
          "--ref-source",
          "exec",
          "--ref-id",
          "openai",
          "--dry-run",
        ]),
      ).rejects.toThrow("__exit__:1");

      expect(mockResolveSecretRefValue).not.toHaveBeenCalled();
      expectErrorIncludes('Secret provider "runner" is not configured');
    });

    it("fails dry-run when skipped exec refs use a provider with mismatched source", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
        secrets: {
          providers: {
            runner: {
              source: "env",
            },
          },
        },
      };
      setSnapshot(resolved, resolved);

      await expect(
        runConfigCommand([
          "config",
          "set",
          "channels.discord.token",
          "--ref-provider",
          "runner",
          "--ref-source",
          "exec",
          "--ref-id",
          "openai",
          "--dry-run",
        ]),
      ).rejects.toThrow("__exit__:1");

      expect(mockResolveSecretRefValue).not.toHaveBeenCalled();
      expectErrorIncludes('Secret provider "runner" has source "env" but ref requests "exec".');
    });

    it("writes sibling SecretRef paths when target uses sibling-ref shape", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
        channels: {
          googlechat: {
            enabled: true,
          } as never,
        } as never,
      };
      setSnapshot(resolved, resolved);

      await runConfigCommand([
        "config",
        "set",
        "channels.googlechat.serviceAccount",
        "--ref-provider",
        "vaultfile",
        "--ref-source",
        "file",
        "--ref-id",
        "/providers/googlechat/serviceAccount",
      ]);

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const written = mockWriteConfigFile.mock.calls[0]?.[0];
      expect(written.channels?.googlechat?.serviceAccountRef).toEqual({
        source: "file",
        provider: "vaultfile",
        id: "/providers/googlechat/serviceAccount",
      });
      expect(written.channels?.googlechat?.serviceAccount).toBeUndefined();
    });

    it("rejects mixing ref-builder and provider-builder flags", async () => {
      await expect(
        runConfigCommand([
          "config",
          "set",
          "channels.discord.token",
          "--ref-provider",
          "default",
          "--ref-source",
          "env",
          "--ref-id",
          "DISCORD_BOT_TOKEN",
          "--provider-source",
          "env",
        ]),
      ).rejects.toThrow("__exit__:1");

      expectErrorIncludes("config set mode error: choose exactly one mode");
    });

    it("rejects mixing batch mode with builder flags", async () => {
      await expect(
        runConfigCommand([
          "config",
          "set",
          "--batch-json",
          "[]",
          "--ref-provider",
          "default",
          "--ref-source",
          "env",
          "--ref-id",
          "DISCORD_BOT_TOKEN",
        ]),
      ).rejects.toThrow("__exit__:1");

      expectErrorIncludes(
        "config set mode error: batch mode (--batch-json/--batch-file) cannot be combined",
      );
    });

    it("supports batch-file mode", async () => {
      const resolved: OpenClawConfig = { gateway: { port: 18789 } };
      setSnapshot(resolved, resolved);

      const pathname = path.join(
        os.tmpdir(),
        `openclaw-config-batch-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
      );
      fs.writeFileSync(pathname, '[{"path":"gateway.auth.mode","value":"token"}]', "utf8");
      try {
        await runConfigCommand(["config", "set", "--batch-file", pathname]);
      } finally {
        fs.rmSync(pathname, { force: true });
      }

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const written = mockWriteConfigFile.mock.calls[0]?.[0];
      expect(written.gateway?.auth).toEqual({ mode: "token" });
    });

    it("batch-file nested leaf updates preserve agents defaults and list siblings", async () => {
      const resolved: OpenClawConfig = {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": { alias: "GPT" },
            },
            model: { primary: "openai/gpt-5.4" },
          },
          list: [{ id: "main" }, { id: "ops" }],
        },
        plugins: {
          entries: {
            "github-copilot": { enabled: true },
          },
        },
      };
      setSnapshot(resolved, resolved);

      const pathname = path.join(
        os.tmpdir(),
        `openclaw-config-memory-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
      );
      fs.writeFileSync(
        pathname,
        JSON.stringify([
          { path: "agents.defaults.memorySearch.enabled", value: true },
          { path: "agents.defaults.memorySearch.provider", value: "gemini" },
          { path: "agents.defaults.memorySearch.sources", value: ["memory"] },
        ]),
        "utf8",
      );
      try {
        await runConfigCommand(["config", "set", "--batch-file", pathname]);
      } finally {
        fs.rmSync(pathname, { force: true });
      }

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const written = mockWriteConfigFile.mock.calls[0]?.[0];
      expect(written.agents?.defaults?.models).toEqual(resolved.agents?.defaults?.models);
      expect(written.agents?.defaults?.model).toEqual(resolved.agents?.defaults?.model);
      expect(written.agents?.defaults?.memorySearch).toEqual({
        enabled: true,
        provider: "gemini",
        sources: ["memory"],
      });
      expect(written.agents?.list).toEqual(resolved.agents?.list);
      expect(written.plugins).toEqual(resolved.plugins);
    });

    it("rejects malformed batch-file payloads", async () => {
      const pathname = path.join(
        os.tmpdir(),
        `openclaw-config-batch-invalid-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
      );
      fs.writeFileSync(pathname, '{"path":"gateway.auth.mode","value":"token"}', "utf8");
      try {
        await expect(runConfigCommand(["config", "set", "--batch-file", pathname])).rejects.toThrow(
          "__exit__:1",
        );
      } finally {
        fs.rmSync(pathname, { force: true });
      }

      expectErrorIncludes("--batch-file must be a JSON array.");
    });

    it("patches config from one object in one write", async () => {
      const resolved = {
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": { alias: "GPT 5.4" },
            },
          },
        },
      } as unknown as OpenClawConfig;
      setSnapshot(resolved, resolved);

      const pathname = path.join(
        os.tmpdir(),
        `openclaw-config-patch-${Date.now()}-${Math.random().toString(16).slice(2)}.json5`,
      );
      fs.writeFileSync(
        pathname,
        JSON.stringify({
          channels: {
            slack: {
              enabled: true,
              mode: "socket",
              botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
              appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
              groupPolicy: "open",
              requireMention: false,
            },
            discord: {
              enabled: true,
              token: { source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" },
              groupPolicy: "allowlist",
            },
          },
          agents: {
            defaults: {
              model: { primary: "openai/gpt-5.5" },
              models: {
                "openai/gpt-5.5": { params: { fastMode: true } },
              },
            },
          },
        }),
        "utf8",
      );
      try {
        await runConfigCommand(["config", "patch", "--file", pathname]);
      } finally {
        fs.rmSync(pathname, { force: true });
      }

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const written = mockWriteConfigFile.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(
        ((written.agents as Record<string, unknown>).defaults as Record<string, unknown>).models,
      ).toEqual({
        "openai/gpt-5.4": { alias: "GPT 5.4" },
        "openai/gpt-5.5": { params: { fastMode: true } },
      });
      expect(
        (
          ((written.agents as Record<string, unknown>).defaults as Record<string, unknown>)
            .model as Record<string, unknown>
        ).primary,
      ).toBe("openai/gpt-5.5");
      expect(
        ((written.channels as Record<string, unknown>).slack as Record<string, unknown>).botToken,
      ).toEqual({ source: "env", provider: "default", id: "SLACK_BOT_TOKEN" });
      expect(
        ((written.channels as Record<string, unknown>).discord as Record<string, unknown>).token,
      ).toEqual({ source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" });
    });

    it("preserves empty object values in config patch", async () => {
      const resolved = {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": { alias: "GPT 5.4" },
            },
          },
        },
      } as unknown as OpenClawConfig;
      setSnapshot(resolved, resolved);

      const pathname = writeTempJson5File("openclaw-config-patch-empty-object", {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.5": {},
            },
          },
        },
      });
      try {
        await runConfigCommand(["config", "patch", "--file", pathname]);
      } finally {
        fs.rmSync(pathname, { force: true });
      }

      const written = mockWriteConfigFile.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(
        ((written.agents as Record<string, unknown>).defaults as Record<string, unknown>).models,
      ).toEqual({
        "openai/gpt-5.4": { alias: "GPT 5.4" },
        "openai/gpt-5.5": {},
      });
    });

    it("treats empty object config patches as recursive merges", async () => {
      const resolved = {
        channels: {
          slack: {
            enabled: true,
            mode: "socket",
          },
        },
      } as unknown as OpenClawConfig;
      setSnapshot(resolved, resolved);

      const pathname = writeTempJson5File("openclaw-config-patch-empty-merge", {
        channels: {
          slack: {},
        },
      });
      try {
        await runConfigCommand(["config", "patch", "--file", pathname]);
      } finally {
        fs.rmSync(pathname, { force: true });
      }

      const written = mockWriteConfigFile.mock.calls[0]?.[0] as Record<string, unknown>;
      expect((written.channels as Record<string, unknown>).slack).toEqual({
        enabled: true,
        mode: "socket",
      });
    });

    it("dry-runs config patch and resolves changed SecretRefs", async () => {
      const resolved = {
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      } as unknown as OpenClawConfig;
      setSnapshot(resolved, resolved);

      const pathname = path.join(
        os.tmpdir(),
        `openclaw-config-patch-dry-${Date.now()}-${Math.random().toString(16).slice(2)}.json5`,
      );
      fs.writeFileSync(
        pathname,
        JSON.stringify({
          channels: {
            discord: {
              token: { source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" },
            },
          },
        }),
        "utf8",
      );
      try {
        await runConfigCommand(["config", "patch", "--file", pathname, "--dry-run"]);
      } finally {
        fs.rmSync(pathname, { force: true });
      }

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expect(mockResolveSecretRefValue).toHaveBeenCalledTimes(1);
      const [secretRef, resolveOptions] = requireResolveSecretRefCall(0);
      expect(secretRef).toEqual({ source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" });
      expect(resolveOptions).toBeTypeOf("object");
    });

    it("schema-validates SecretRef-only config patch operations", async () => {
      const resolved = {
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      } as unknown as OpenClawConfig;
      setSnapshot(resolved, resolved);

      const pathname = path.join(
        os.tmpdir(),
        `openclaw-config-patch-ref-schema-${Date.now()}-${Math.random()
          .toString(16)
          .slice(2)}.json5`,
      );
      fs.writeFileSync(
        pathname,
        JSON.stringify({
          gateway: {
            typo: { source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" },
          },
        }),
        "utf8",
      );
      try {
        await expect(
          runConfigCommand(["config", "patch", "--file", pathname, "--dry-run"]),
        ).rejects.toThrow("__exit__:1");
      } finally {
        fs.rmSync(pathname, { force: true });
      }

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expect(mockResolveSecretRefValue).toHaveBeenCalledTimes(1);
      expectErrorIncludes("Dry run failed: config schema validation failed.");
      expectErrorIncludes("gateway");
      expectErrorIncludes('"typo"');
    });

    it("dry-runs nested SecretRefs inside config patch replacements", async () => {
      const resolved = {
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
        channels: {
          slack: {
            enabled: false,
          },
        },
      } as unknown as OpenClawConfig;
      setSnapshot(resolved, resolved);
      mockResolveSecretRefValue.mockRejectedValue(new Error("missing env var"));

      const pathname = path.join(
        os.tmpdir(),
        `openclaw-config-patch-nested-ref-${Date.now()}-${Math.random()
          .toString(16)
          .slice(2)}.json5`,
      );
      fs.writeFileSync(
        pathname,
        JSON.stringify({
          channels: {
            slack: {
              enabled: true,
              mode: "socket",
              botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
              appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
            },
          },
        }),
        "utf8",
      );
      try {
        await expect(
          runConfigCommand([
            "config",
            "patch",
            "--file",
            pathname,
            "--replace-path",
            "channels.slack",
            "--dry-run",
          ]),
        ).rejects.toThrow("__exit__:1");
      } finally {
        fs.rmSync(pathname, { force: true });
      }

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expect(mockResolveSecretRefValue).toHaveBeenCalledTimes(2);
      expectErrorIncludes("Dry run failed: 2 SecretRef assignment(s) could not be resolved.");
    });

    it("rejects config patch --json without dry-run", async () => {
      await expect(runConfigCommand(["config", "patch", "--stdin", "--json"])).rejects.toThrow(
        "__exit__:1",
      );
      expectErrorIncludes("config patch mode error: --json requires --dry-run.");
      expect(mockWriteConfigFile).not.toHaveBeenCalled();
    });

    it("supports replace-path and null deletes in config patch", async () => {
      const resolved = {
        channels: {
          slack: {
            appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
          },
          discord: {
            guilds: {
              guild: {
                channels: {
                  old: { enabled: true },
                },
              },
            },
          },
        },
      } as unknown as OpenClawConfig;
      setSnapshot(resolved, resolved);

      const pathname = path.join(
        os.tmpdir(),
        `openclaw-config-patch-replace-${Date.now()}-${Math.random().toString(16).slice(2)}.json5`,
      );
      fs.writeFileSync(
        pathname,
        JSON.stringify({
          channels: {
            slack: {
              appToken: null,
            },
            discord: {
              guilds: {
                guild: {
                  channels: {
                    maintainers: { enabled: true, requireMention: true },
                  },
                },
              },
            },
          },
        }),
        "utf8",
      );
      try {
        await runConfigCommand([
          "config",
          "patch",
          "--file",
          pathname,
          "--replace-path",
          "channels.discord.guilds.guild.channels",
        ]);
      } finally {
        fs.rmSync(pathname, { force: true });
      }

      const written = mockWriteConfigFile.mock.calls[0]?.[0] as Record<string, unknown>;
      const channels = (written.channels as Record<string, unknown>).discord as Record<
        string,
        unknown
      >;
      expect(
        ((channels.guilds as Record<string, unknown>).guild as Record<string, unknown>)
          .channels as Record<string, unknown>,
      ).toEqual({ maintainers: { enabled: true, requireMention: true } });
      expect((written.channels as Record<string, unknown>).slack).not.toHaveProperty("appToken");
      expect(requireWriteOptions().unsetPaths).toEqual([["channels", "slack", "appToken"]]);
    });

    it("rejects unused config patch replace paths", async () => {
      const pathname = path.join(
        os.tmpdir(),
        `openclaw-config-patch-unused-replace-${Date.now()}-${Math.random()
          .toString(16)
          .slice(2)}.json5`,
      );
      fs.writeFileSync(
        pathname,
        JSON.stringify({
          channels: {
            discord: {
              enabled: true,
            },
          },
        }),
        "utf8",
      );
      try {
        await expect(
          runConfigCommand([
            "config",
            "patch",
            "--file",
            pathname,
            "--replace-path",
            "channels.discord.guilds",
          ]),
        ).rejects.toThrow("__exit__:1");
      } finally {
        fs.rmSync(pathname, { force: true });
      }

      expectErrorIncludes(
        "config patch mode error: --replace-path channels.discord.guilds did not match any value in the input patch.",
      );
      expect(mockWriteConfigFile).not.toHaveBeenCalled();
    });

    it("rejects malformed batch entries with mixed operation keys", async () => {
      await expect(
        runConfigCommand([
          "config",
          "set",
          "--batch-json",
          '[{"path":"channels.discord.token","value":"x","ref":{"source":"env","provider":"default","id":"DISCORD_BOT_TOKEN"}}]',
        ]),
      ).rejects.toThrow("__exit__:1");

      expectErrorIncludes("must include exactly one of: value, ref, provider");
    });

    it("fails dry-run when a builder-assigned SecretRef is unresolved", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      };
      setSnapshot(resolved, resolved);
      mockResolveSecretRefValue.mockRejectedValueOnce(new Error("missing env var"));

      await expect(
        runConfigCommand([
          "config",
          "set",
          "channels.discord.token",
          "--ref-provider",
          "default",
          "--ref-source",
          "env",
          "--ref-id",
          "DISCORD_BOT_TOKEN",
          "--dry-run",
        ]),
      ).rejects.toThrow("__exit__:1");

      expectErrorIncludes("Dry run failed: 1 SecretRef assignment(s) could not be resolved.");
    });

    it("emits structured JSON for --dry-run --json success", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      };
      setSnapshot(resolved, resolved);

      await runConfigCommand([
        "config",
        "set",
        "channels.discord.token",
        "--ref-provider",
        "default",
        "--ref-source",
        "env",
        "--ref-id",
        "DISCORD_BOT_TOKEN",
        "--dry-run",
        "--json",
      ]);

      const raw = mockLog.mock.calls.at(-1)?.[0];
      expect(typeof raw).toBe("string");
      const payload = JSON.parse(String(raw)) as {
        ok: boolean;
        checks: { schema: boolean; resolvability: boolean; resolvabilityComplete: boolean };
        refsChecked: number;
        skippedExecRefs: number;
        operations: number;
      };
      expect(payload.ok).toBe(true);
      expect(payload.operations).toBe(1);
      expect(payload.refsChecked).toBe(1);
      expect(payload.skippedExecRefs).toBe(0);
      expect(payload.checks).toEqual({
        schema: false,
        resolvability: true,
        resolvabilityComplete: true,
      });
    });

    it("emits skipped exec metadata for --dry-run --json success", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
        secrets: {
          providers: {
            runner: {
              source: "exec",
              command: "/usr/bin/env",
              allowInsecurePath: true,
            },
          },
        },
      };
      setSnapshot(resolved, resolved);

      await runConfigCommand([
        "config",
        "set",
        "channels.discord.token",
        "--ref-provider",
        "runner",
        "--ref-source",
        "exec",
        "--ref-id",
        "openai",
        "--dry-run",
        "--json",
      ]);

      const raw = mockLog.mock.calls.at(-1)?.[0];
      expect(typeof raw).toBe("string");
      const payload = JSON.parse(String(raw)) as {
        ok: boolean;
        checks: { resolvability: boolean; resolvabilityComplete: boolean };
        refsChecked: number;
        skippedExecRefs: number;
      };
      expect(payload.ok).toBe(true);
      expect(payload.checks.resolvability).toBe(true);
      expect(payload.checks.resolvabilityComplete).toBe(false);
      expect(payload.refsChecked).toBe(0);
      expect(payload.skippedExecRefs).toBe(1);
    });

    it("emits structured JSON for --dry-run --json failure", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      };
      setSnapshot(resolved, resolved);
      mockResolveSecretRefValue.mockRejectedValueOnce(new Error("missing env var"));

      await expect(
        runConfigCommand([
          "config",
          "set",
          "channels.discord.token",
          "--ref-provider",
          "default",
          "--ref-source",
          "env",
          "--ref-id",
          "DISCORD_BOT_TOKEN",
          "--dry-run",
          "--json",
        ]),
      ).rejects.toThrow("__exit__:1");

      const raw = mockLog.mock.calls.at(-1)?.[0];
      expect(typeof raw).toBe("string");
      const payload = JSON.parse(String(raw)) as {
        ok: boolean;
        errors?: Array<{ kind: string; message: string; ref?: string }>;
      };
      expect(payload.ok).toBe(false);
      const errorKinds = (payload.errors ?? []).map((entry) => entry.kind);
      expect(errorKinds).toContain("resolvability");
      const errorRefs = (payload.errors ?? []).map((entry) => entry.ref ?? "");
      const discordTokenRefs = errorRefs.filter((ref) => ref.includes("default:DISCORD_BOT_TOKEN"));
      expect(discordTokenRefs.length).toBeGreaterThan(0);
    });

    it("keeps distinct resolvability failures when messages are identical but refs differ", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      };
      setSnapshot(resolved, resolved);

      await expect(
        runConfigCommand([
          "config",
          "set",
          "--batch-json",
          '[{"path":"channels.discord.token","ref":{"source":"exec","provider":"default","id":"DISCORD_BOT_TOKEN"}},{"path":"channels.telegram.botToken","ref":{"source":"exec","provider":"default","id":"TELEGRAM_BOT_TOKEN"}}]',
          "--dry-run",
          "--json",
        ]),
      ).rejects.toThrow("__exit__:1");

      const raw = mockLog.mock.calls.at(-1)?.[0];
      expect(typeof raw).toBe("string");
      const payload = JSON.parse(String(raw)) as {
        ok: boolean;
        errors?: Array<{ kind: string; message: string; ref?: string }>;
      };
      expect(payload.ok).toBe(false);
      const resolvabilityErrors =
        payload.errors?.filter((entry) => entry.kind === "resolvability") ?? [];
      expect(resolvabilityErrors).toHaveLength(2);
      expect(
        resolvabilityErrors.some((entry) => entry.ref === "exec:default:DISCORD_BOT_TOKEN"),
      ).toBe(true);
      expect(
        resolvabilityErrors.some((entry) => entry.ref === "exec:default:TELEGRAM_BOT_TOKEN"),
      ).toBe(true);
    });

    it("aggregates schema and resolvability failures in --dry-run --json mode", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      };
      setSnapshot(resolved, resolved);
      mockResolveSecretRefValue.mockRejectedValue(new Error("missing env var"));

      await expect(
        runConfigCommand([
          "config",
          "set",
          "--batch-json",
          '[{"path":"gateway.port","value":"not-a-number"},{"path":"channels.discord.token","ref":{"source":"env","provider":"default","id":"DISCORD_BOT_TOKEN"}}]',
          "--dry-run",
          "--json",
        ]),
      ).rejects.toThrow("__exit__:1");

      const raw = mockLog.mock.calls.at(-1)?.[0];
      expect(typeof raw).toBe("string");
      const payload = JSON.parse(String(raw)) as {
        ok: boolean;
        errors?: Array<{ kind: string; message: string; ref?: string }>;
      };
      expect(payload.ok).toBe(false);
      const errorKinds = (payload.errors ?? []).map((entry) => entry.kind);
      expect(errorKinds).toContain("schema");
      expect(errorKinds).toContain("resolvability");
      const errorRefs = (payload.errors ?? []).map((entry) => entry.ref ?? "");
      const discordTokenRefs = errorRefs.filter((ref) => ref.includes("default:DISCORD_BOT_TOKEN"));
      expect(discordTokenRefs.length).toBeGreaterThan(0);
    });

    it("fails dry-run when provider updates make existing refs unresolvable", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
        secrets: {
          providers: {
            vaultfile: { source: "file", path: "/tmp/secrets.json", mode: "json" },
          },
        },
        tools: {
          web: {
            search: {
              enabled: true,
              apiKey: {
                source: "file",
                provider: "vaultfile",
                id: "/providers/search/apiKey",
              },
            },
          },
        } as never,
      };
      setSnapshot(resolved, resolved);
      mockResolveSecretRefValue.mockImplementationOnce(async () => {
        throw new Error("provider mismatch");
      });

      await expect(
        runConfigCommand([
          "config",
          "set",
          "secrets.providers.vaultfile",
          "--provider-source",
          "env",
          "--dry-run",
        ]),
      ).rejects.toThrow("__exit__:1");

      expectErrorIncludes("Dry run failed: 1 SecretRef assignment(s) could not be resolved.");
      expectErrorIncludes("provider mismatch");
    });

    it("fails dry-run for nested provider edits that make existing refs unresolvable", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
        secrets: {
          providers: {
            vaultfile: { source: "file", path: "/tmp/secrets.json", mode: "json" },
          },
        },
        tools: {
          web: {
            search: {
              enabled: true,
              apiKey: {
                source: "file",
                provider: "vaultfile",
                id: "/providers/search/apiKey",
              },
            },
          },
        } as never,
      };
      setSnapshot(resolved, resolved);
      mockResolveSecretRefValue.mockImplementationOnce(async () => {
        throw new Error("provider mismatch");
      });

      await expect(
        runConfigCommand([
          "config",
          "set",
          "secrets.providers.vaultfile.path",
          '"/tmp/other-secrets.json"',
          "--strict-json",
          "--dry-run",
        ]),
      ).rejects.toThrow("__exit__:1");

      const [secretRef, resolveOptions] = requireResolveSecretRefCall(0);
      const secretRefRecord = requireRecord(secretRef, "existing SecretRef");
      expect(secretRefRecord.provider).toBe("vaultfile");
      expect(secretRefRecord.id).toBe("/providers/search/apiKey");
      expect(resolveOptions).toBeTypeOf("object");
      expectErrorIncludes("Dry run failed: 1 SecretRef assignment(s) could not be resolved.");
      expectErrorIncludes("provider mismatch");
    });
  });

  describe("path hardening", () => {
    it("rejects blocked prototype-key segments for config get", async () => {
      await expect(runConfigCommand(["config", "get", "gateway.__proto__.token"])).rejects.toThrow(
        "Invalid path segment: __proto__",
      );

      expect(mockReadConfigFileSnapshot).not.toHaveBeenCalled();
      expect(mockWriteConfigFile).not.toHaveBeenCalled();
    });

    it("rejects blocked prototype-key segments for config set", async () => {
      await expect(
        runConfigCommand(["config", "set", "tools.constructor.profile", '"sandbox"']),
      ).rejects.toThrow("Invalid path segment: constructor");

      expect(mockReadConfigFileSnapshot).not.toHaveBeenCalled();
      expect(mockWriteConfigFile).not.toHaveBeenCalled();
    });

    it("rejects blocked prototype-key segments for config unset", async () => {
      await expect(
        runConfigCommand(["config", "unset", "channels.prototype.enabled"]),
      ).rejects.toThrow("Invalid path segment: prototype");

      expect(mockReadConfigFileSnapshot).not.toHaveBeenCalled();
      expect(mockWriteConfigFile).not.toHaveBeenCalled();
    });
  });

  describe("config unset - issue #6070", () => {
    it("preserves existing config keys when unsetting a value", async () => {
      const resolved: OpenClawConfig = {
        agents: { list: [{ id: "main" }] },
        gateway: { port: 18789 },
        tools: {
          profile: "coding",
          alsoAllow: ["agents_list"],
        },
        logging: { level: "debug" },
      };
      const runtimeMerged: OpenClawConfig = {
        ...withRuntimeDefaults(resolved),
      };
      setSnapshot(resolved, runtimeMerged);

      await runConfigCommand(["config", "unset", "tools.alsoAllow"]);

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const written = mockWriteConfigFile.mock.calls[0]?.[0];
      expect(written.tools).not.toHaveProperty("alsoAllow");
      expect(written.agents).not.toHaveProperty("defaults");
      expect(written.agents?.list).toEqual(resolved.agents?.list);
      expect(written.gateway).toEqual(resolved.gateway);
      expect(written.tools?.profile).toBe("coding");
      expect(written.logging).toEqual(resolved.logging);
      expect(mockWriteConfigFile.mock.calls[0]?.[1]).toEqual({
        unsetPaths: [["tools", "alsoAllow"]],
      });
    });

    it("removes only the specified array element", async () => {
      const resolved: OpenClawConfig = {
        agents: {
          list: [{ id: "agent-a" }, { id: "agent-b" }, { id: "agent-c" }],
        },
      };
      const runtimeMerged: OpenClawConfig = {
        ...withRuntimeDefaults(resolved),
      };
      setSnapshot(resolved, runtimeMerged);

      await runConfigCommand(["config", "unset", "agents.list[1]"]);

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const written = mockWriteConfigFile.mock.calls[0]?.[0];
      expect(written.agents?.list).toEqual([{ id: "agent-a" }, { id: "agent-c" }]);
      expect(mockWriteConfigFile.mock.calls[0]?.[1]).toBeUndefined();
    });

    it("preserves write-level unset handling for numeric object keys", async () => {
      const resolved: OpenClawConfig = {
        channels: {
          discord: {
            guilds: {
              "123": { channels: ["general"] },
              "456": { channels: ["alerts"] },
            },
          },
        },
      } as unknown as OpenClawConfig;
      setSnapshot(resolved, resolved);

      await runConfigCommand(["config", "unset", "channels.discord.guilds.123"]);

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const written = mockWriteConfigFile.mock.calls[0]?.[0] as {
        channels?: { discord?: { guilds?: Record<string, unknown> } };
      };
      expect(written.channels?.discord?.guilds).toEqual({
        "456": { channels: ["alerts"] },
      });
      expect(mockWriteConfigFile.mock.calls[0]?.[1]).toEqual({
        unsetPaths: [["channels", "discord", "guilds", "123"]],
      });
    });
  });

  describe("config file", () => {
    it("prints the active config file path", async () => {
      const resolved: OpenClawConfig = { gateway: { port: 18789 } };
      setSnapshot(resolved, resolved);

      await runConfigCommand(["config", "file"]);

      expect(mockLog).toHaveBeenCalledWith("/tmp/openclaw.json");
      expect(mockWriteConfigFile).not.toHaveBeenCalled();
    });

    it("handles config file path with home directory", async () => {
      const resolved: OpenClawConfig = { gateway: { port: 18789 } };
      const snapshot = buildSnapshot({ resolved, config: resolved });
      snapshot.path = "/home/user/.openclaw/openclaw.json";
      mockReadConfigFileSnapshot.mockResolvedValueOnce(snapshot);

      await runConfigCommand(["config", "file"]);

      expect(mockLog).toHaveBeenCalledWith("/home/user/.openclaw/openclaw.json");
    });
  });
});
