import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createDaytonaPluginConfigSchema, resolveDaytonaPluginConfig } from "./config.js";

describe("resolveDaytonaPluginConfig", () => {
  it("returns defaults when config is missing", () => {
    expect(resolveDaytonaPluginConfig(undefined)).toEqual({
      remoteWorkspaceDir: "/home/daytona/workspace",
      remoteAgentWorkspaceDir: "/home/daytona/agent",
      timeoutMs: 120_000,
    });
  });

  it("resolves configured values", () => {
    const resolved = resolveDaytonaPluginConfig({
      apiKey: "dtn_test",
      apiUrl: "https://daytona.example.com/api",
      target: "us",
      snapshot: "my-snapshot",
      autoStopInterval: 0,
      autoDeleteInterval: 60,
      networkBlockAll: true,
      remoteWorkspaceDir: "/workspaces/session/",
      remoteAgentWorkspaceDir: "/workspaces-agent",
      timeoutSeconds: 30.7,
    });
    expect(resolved).toEqual({
      apiKey: "dtn_test",
      apiUrl: "https://daytona.example.com/api",
      target: "us",
      snapshot: "my-snapshot",
      autoStopInterval: 0,
      autoDeleteInterval: 60,
      networkBlockAll: true,
      remoteWorkspaceDir: "/workspaces/session",
      remoteAgentWorkspaceDir: "/workspaces-agent",
      timeoutMs: 30_700,
    });
  });

  it("accepts SecretRef apiKey values", () => {
    const resolved = resolveDaytonaPluginConfig({
      apiKey: { source: "env", provider: "default", id: "DAYTONA_API_KEY" },
    });
    expect(resolved.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "DAYTONA_API_KEY",
    });
  });

  it("normalizes remote paths and keeps them absolute", () => {
    const resolved = resolveDaytonaPluginConfig({
      remoteWorkspaceDir: "/srv/../srv/workspace",
    });
    expect(resolved.remoteWorkspaceDir).toBe("/srv/workspace");
  });

  it.each([
    ["relative path", { remoteWorkspaceDir: "workspace" }, /must be an absolute POSIX path/],
    ["root path", { remoteWorkspaceDir: "/" }, /must not be the filesystem root/],
    [
      "nested roots",
      { remoteWorkspaceDir: "/data", remoteAgentWorkspaceDir: "/data/agent" },
      /distinct, non-nested/,
    ],
    [
      "equal roots",
      { remoteWorkspaceDir: "/data", remoteAgentWorkspaceDir: "/data" },
      /distinct, non-nested/,
    ],
  ])("rejects %s", (_name, config, message) => {
    expect(() => resolveDaytonaPluginConfig(config)).toThrow(message);
  });

  it.each([
    ["unknown keys", { unknown: true }],
    ["negative autoStopInterval", { autoStopInterval: -1 }],
    ["fractional autoStopInterval", { autoStopInterval: 1.5 }],
    ["empty snapshot", { snapshot: " " }],
    ["oversized timeout", { timeoutSeconds: 2_147_001 }],
    ["invalid secret ref", { apiKey: { source: "env", provider: "default", id: "lowercase" } }],
  ])("rejects %s", (_name, config) => {
    expect(() => resolveDaytonaPluginConfig(config)).toThrow(/Invalid daytona plugin config/);
  });
});

describe("createDaytonaPluginConfigSchema", () => {
  it("matches the manifest config schema", () => {
    const manifestPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "openclaw.plugin.json",
    );
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      configSchema: unknown;
    };
    expect(createDaytonaPluginConfigSchema().jsonSchema).toEqual(manifest.configSchema);
  });
});
