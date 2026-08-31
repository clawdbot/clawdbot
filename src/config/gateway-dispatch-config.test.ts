// Covers gateway dispatch config loading and fallback behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readGatewayDispatchConfig,
  readGatewayDispatchConfigWithShellEnvFallback,
} from "./gateway-dispatch-config.js";

const shellEnvMocks = vi.hoisted(() => ({
  loadShellEnvFallback: vi.fn(),
  resolveShellEnvFallbackTimeoutMs: vi.fn(() => 50),
  shouldDeferShellEnvFallback: vi.fn(() => false),
  shouldEnableShellEnvFallback: vi.fn(() => false),
}));

vi.mock("../infra/shell-env.js", () => shellEnvMocks);

const tempDirs: string[] = [];

function createTempConfig(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gateway-dispatch-config-"));
  tempDirs.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), contents);
  }
  return path.join(dir, "openclaw.json5");
}

afterEach(() => {
  vi.clearAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("readGatewayDispatchConfig", () => {
  it("reads only gateway dispatch fields from JSON5 config with includes and env vars", () => {
    const configPath = createTempConfig({
      "gateway-base.json5": `{
        gateway: {
          port: 18888,
          auth: { mode: "token", token: "\${OPENCLAW_GATEWAY_TOKEN}" },
        },
        models: { providers: { expensive: { apiKey: "\${MISSING_MODEL_KEY}" } } },
      }`,
      "openclaw.json5": `{
        $include: "./gateway-base.json5",
        env: { vars: { OPENCLAW_GATEWAY_TOKEN: "inline-token" } },
        agents: {
          defaults: { timeoutSeconds: 42 },
          list: [{ id: "ops", default: true }],
        },
        plugins: {
          allow: ["vault"],
          entries: { vault: { enabled: true } },
          load: { paths: ["./plugins/vault"] },
        },
        session: { mainKey: "main-ops", store: "./sessions.json" },
      }`,
    });
    const env = { OPENCLAW_CONFIG_PATH: configPath };

    const config = readGatewayDispatchConfig({ env });

    expect(config.gateway?.port).toBe(18888);
    expect(config.gateway?.auth).toMatchObject({ mode: "token", token: "inline-token" });
    expect(config.agents?.defaults?.timeoutSeconds).toBe(42);
    expect(config.agents?.list?.[0]?.id).toBe("ops");
    expect(config.plugins).toEqual({
      allow: ["vault"],
      entries: { vault: { enabled: true } },
      load: { paths: ["./plugins/vault"] },
    });
    expect(config.session?.mainKey).toBe("main");
    expect((config as { models?: unknown }).models).toBeUndefined();
    expect(shellEnvMocks.loadShellEnvFallback).not.toHaveBeenCalled();
  });

  it("loads only gateway credential shell env keys on explicit fallback", async () => {
    const configPath = createTempConfig({
      "openclaw.json5": `{
        env: { shellEnv: { enabled: true, timeoutMs: 123 } },
        gateway: { auth: { mode: "token", token: "\${OPENCLAW_GATEWAY_TOKEN}" } },
      }`,
    });
    const env: NodeJS.ProcessEnv = { OPENCLAW_CONFIG_PATH: configPath };
    shellEnvMocks.loadShellEnvFallback.mockImplementation(({ env: targetEnv }) => {
      targetEnv.OPENCLAW_GATEWAY_TOKEN = "shell-token";
    });

    const config = await readGatewayDispatchConfigWithShellEnvFallback({ env });

    expect(shellEnvMocks.loadShellEnvFallback).toHaveBeenCalledWith({
      enabled: true,
      env,
      expectedKeys: ["OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_GATEWAY_PASSWORD"],
      logger: console,
      timeoutMs: 123,
    });
    expect(config.gateway?.auth).toMatchObject({ mode: "token", token: "shell-token" });
  });
});
