import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createDaytonaPluginConfigSchema, resolveDaytonaPluginConfig } from "./config.js";

describe("resolveDaytonaPluginConfig", () => {
  it("returns defaults when config is missing", () => {
    expect(resolveDaytonaPluginConfig(undefined)).toEqual({
      networkBlockAll: true,
      remoteWorkspaceDir: "/home/daytona/workspace",
      remoteAgentWorkspaceDir: "/home/daytona/agent",
      timeoutMs: 120_000,
    });
  });

  it.each([
    ["denies egress by default", {}, true],
    [
      "treats configured allow lists as explicit selective egress",
      { networkAllowList: "10.0.0.0/24" },
      false,
    ],
    [
      "treats domain allow lists as explicit selective egress",
      { domainAllowList: "example.com" },
      false,
    ],
    ["keeps explicit egress opt-in", { networkBlockAll: false }, false],
    [
      "keeps explicit blockAll over allow lists",
      { networkBlockAll: true, networkAllowList: "10.0.0.0/24" },
      true,
    ],
  ])("%s", (_name, config, expected) => {
    expect(resolveDaytonaPluginConfig(config).networkBlockAll).toBe(expected);
  });

  it("resolves configured values", () => {
    const resolved = resolveDaytonaPluginConfig({
      apiKey: "dtn_test",
      apiUrl: "https://daytona.example.com/api",
      target: "us",
      snapshot: "my-snapshot",
      user: "runner",
      volumes: [{ volumeId: "vol-1", mountPath: "/data/shared/" }],
      autoStopInterval: 0,
      autoPauseInterval: 30,
      autoArchiveInterval: 120,
      autoDeleteInterval: 60,
      networkBlockAll: true,
      networkAllowList: "10.0.0.0/24,192.168.0.0/16",
      domainAllowList: "registry.npmjs.org,pypi.org",
      remoteWorkspaceDir: "/workspaces/session/",
      remoteAgentWorkspaceDir: "/workspaces-agent",
      timeoutSeconds: 30.7,
    });
    expect(resolved).toEqual({
      apiKey: "dtn_test",
      apiUrl: "https://daytona.example.com/api",
      target: "us",
      snapshot: "my-snapshot",
      image: undefined,
      resources: undefined,
      user: "runner",
      volumes: [{ volumeId: "vol-1", mountPath: "/data/shared" }],
      autoStopInterval: 0,
      autoPauseInterval: 30,
      autoArchiveInterval: 120,
      autoDeleteInterval: 60,
      networkBlockAll: true,
      networkAllowList: "10.0.0.0/24,192.168.0.0/16",
      domainAllowList: "registry.npmjs.org,pypi.org",
      remoteWorkspaceDir: "/workspaces/session",
      remoteAgentWorkspaceDir: "/workspaces-agent",
      timeoutMs: 30_700,
    });
  });

  it("resolves image-based sandbox config with resources", () => {
    const resolved = resolveDaytonaPluginConfig({
      image: "python:3.13-slim",
      resources: { cpu: 2, memory: 4, disk: 10 },
    });
    expect(resolved.image).toBe("python:3.13-slim");
    expect(resolved.resources).toEqual({ cpu: 2, memory: 4, disk: 10 });
    expect(resolved.snapshot).toBeUndefined();
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
    [
      "snapshot combined with image",
      { snapshot: "snap", image: "python:3.13-slim" },
      /mutually exclusive/,
    ],
    ["resources without image", { resources: { cpu: 2 } }, /resources require image/],
    [
      "both idle intervals non-zero",
      { autoStopInterval: 15, autoPauseInterval: 30 },
      /cannot both be non-zero/,
    ],
    [
      "relative volume mountPath",
      { volumes: [{ volumeId: "vol-1", mountPath: "data" }] },
      /must be an absolute POSIX path/,
    ],
    [
      "volume mounted over the workspace root",
      { volumes: [{ volumeId: "vol-1", mountPath: "/home/daytona/workspace/cache" }] },
      /must not overlap the managed workspace dirs/,
    ],
    [
      "volumes nested inside each other",
      {
        volumes: [
          { volumeId: "vol-1", mountPath: "/data" },
          { volumeId: "vol-2", mountPath: "/data/nested" },
        ],
      },
      /must not overlap each other/,
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
    ["zero resource units", { image: "python:3.13-slim", resources: { cpu: 0 } }],
    ["unknown resource keys", { image: "python:3.13-slim", resources: { vram: 1 } }],
    ["empty volume id", { volumes: [{ volumeId: " ", mountPath: "/data" }] }],
    ["unknown volume keys", { volumes: [{ volumeId: "vol-1", mountPath: "/data", ro: true }] }],
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
