import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeStateDirDotEnv } from "../config/test-helpers.js";

const mocks = vi.hoisted(() => ({
  hasAnyAuthProfileStoreSource: vi.fn(() => true),
  loadAuthProfileStoreForSecretsRuntime: vi.fn(),
  resolvePreferredNodePath: vi.fn(),
  resolveGatewayProgramArguments: vi.fn(),
  resolveSystemNodeInfo: vi.fn(),
  renderSystemNodeWarning: vi.fn(),
  buildServiceEnvironment: vi.fn(),
  resolveOpenClawWrapperPath: vi.fn(),
}));

vi.mock("./daemon-install-auth-profiles-source.runtime.js", () => ({
  hasAnyAuthProfileStoreSource: mocks.hasAnyAuthProfileStoreSource,
}));

vi.mock("./daemon-install-auth-profiles-store.runtime.js", () => ({
  loadAuthProfileStoreForSecretsRuntime: mocks.loadAuthProfileStoreForSecretsRuntime,
}));

vi.mock("../daemon/runtime-paths.js", () => ({
  resolvePreferredNodePath: mocks.resolvePreferredNodePath,
  resolveSystemNodeInfo: mocks.resolveSystemNodeInfo,
  renderSystemNodeWarning: mocks.renderSystemNodeWarning,
}));

vi.mock("../daemon/program-args.js", () => ({
  OPENCLAW_WRAPPER_ENV_KEY: "OPENCLAW_WRAPPER",
  resolveGatewayProgramArguments: mocks.resolveGatewayProgramArguments,
  resolveOpenClawWrapperPath: mocks.resolveOpenClawWrapperPath,
}));

vi.mock("../daemon/service-env.js", () => ({
  buildServiceEnvironment: mocks.buildServiceEnvironment,
}));

import {
  buildGatewayInstallPlan,
  gatewayInstallErrorHint,
  resolveGatewayDevMode,
} from "./daemon-install-helpers.js";

afterEach(() => {
  vi.resetAllMocks();
});

describe("resolveGatewayDevMode", () => {
  it("detects dev mode for src ts entrypoints", () => {
    expect(resolveGatewayDevMode(["node", "/Users/me/openclaw/src/cli/index.ts"])).toBe(true);
    expect(resolveGatewayDevMode(["node", "C:\\Users\\me\\openclaw\\src\\cli\\index.ts"])).toBe(
      true,
    );
    expect(resolveGatewayDevMode(["node", "/Users/me/openclaw/dist/cli/index.js"])).toBe(false);
  });
});

function mockNodeGatewayPlanFixture(
  params: {
    workingDirectory?: string;
    version?: string;
    supported?: boolean;
    warning?: string;
    serviceEnvironment?: Record<string, string>;
  } = {},
) {
  const {
    version = "22.0.0",
    supported = true,
    warning,
    serviceEnvironment = { OPENCLAW_PORT: "3000" },
  } = params;
  const workingDirectory = Object.hasOwn(params, "workingDirectory")
    ? params.workingDirectory
    : "/Users/me";
  mocks.resolvePreferredNodePath.mockResolvedValue("/opt/node");
  mocks.resolveOpenClawWrapperPath.mockImplementation(async (value: string | undefined) =>
    value?.trim() ? path.resolve(value) : undefined,
  );
  mocks.resolveGatewayProgramArguments.mockResolvedValue({
    programArguments: ["node", "gateway"],
    workingDirectory,
  });
  mocks.loadAuthProfileStoreForSecretsRuntime.mockReturnValue({
    version: 1,
    profiles: {},
  });
  mocks.resolveSystemNodeInfo.mockResolvedValue({
    path: "/opt/node",
    version,
    supported,
  });
  mocks.renderSystemNodeWarning.mockReturnValue(warning);
  mocks.buildServiceEnvironment.mockReturnValue(serviceEnvironment);
}

describe("buildGatewayInstallPlan", () => {
  // Prevent tests from reading the developer's real ~/.openclaw/.env when
  // passing `env: {}` (which falls back to os.homedir for state-dir resolution).
  let isolatedHome: string;
  beforeEach(() => {
    isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "oc-plan-test-"));
  });
  afterEach(() => {
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  });
  const isolatedPlanEnv = (env: Record<string, string | undefined> = {}) => ({
    HOME: isolatedHome,
    ...env,
  });

  it("uses provided nodePath and returns plan", async () => {
    mockNodeGatewayPlanFixture();

    const plan = await buildGatewayInstallPlan({
      env: { HOME: isolatedHome },
      port: 3000,
      runtime: "node",
      nodePath: "/custom/node",
    });

    expect(plan.programArguments).toEqual(["node", "gateway"]);
    expect(plan.workingDirectory).toBe("/Users/me");
    expect(plan.environment).toEqual({ OPENCLAW_PORT: "3000" });
    expect(mocks.resolvePreferredNodePath).not.toHaveBeenCalled();
    expect(mocks.buildServiceEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        env: { HOME: isolatedHome },
        port: 3000,
        extraPathDirs: ["/custom"],
      }),
    );
  });

  it("does not prepend '.' when nodePath is a bare executable name", async () => {
    mockNodeGatewayPlanFixture();

    await buildGatewayInstallPlan({
      env: { HOME: isolatedHome },
      port: 3000,
      runtime: "node",
      nodePath: "node",
    });

    expect(mocks.buildServiceEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        extraPathDirs: undefined,
      }),
    );
  });

  it("emits warnings when renderSystemNodeWarning returns one", async () => {
    const warn = vi.fn();
    mockNodeGatewayPlanFixture({
      workingDirectory: undefined,
      version: "18.0.0",
      supported: false,
      warning: "Node too old",
      serviceEnvironment: {},
    });

    await buildGatewayInstallPlan({
      env: isolatedPlanEnv(),
      port: 3000,
      runtime: "node",
      warn,
    });

    expect(warn).toHaveBeenCalledWith("Node too old", "Gateway runtime");
    expect(mocks.resolvePreferredNodePath).toHaveBeenCalled();
  });

  it("uses the state dir as the default macOS launchd working directory", async () => {
    mockNodeGatewayPlanFixture({
      workingDirectory: undefined,
      serviceEnvironment: {},
    });

    const plan = await buildGatewayInstallPlan({
      env: isolatedPlanEnv(),
      port: 3000,
      runtime: "node",
      platform: "darwin",
    });

    expect(plan.workingDirectory).toBe(path.join(isolatedHome, ".openclaw"));
    expect(mocks.buildServiceEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: "darwin",
      }),
    );
  });

  it("does not invent a working directory for non-macOS service installs", async () => {
    mockNodeGatewayPlanFixture({
      workingDirectory: undefined,
      serviceEnvironment: {},
    });

    const plan = await buildGatewayInstallPlan({
      env: isolatedPlanEnv(),
      port: 3000,
      runtime: "node",
      platform: "linux",
    });

    expect(plan.workingDirectory).toBeUndefined();
  });

  it("passes OPENCLAW_WRAPPER through program args and managed service env", async () => {
    const wrapperPath = path.resolve("/usr/local/bin/openclaw-doppler");
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        OPENCLAW_PORT: "3000",
        OPENCLAW_WRAPPER: wrapperPath,
      },
    });

    const plan = await buildGatewayInstallPlan({
      env: isolatedPlanEnv({
        OPENCLAW_WRAPPER: wrapperPath,
      }),
      port: 3000,
      runtime: "node",
    });

    expect(mocks.resolveGatewayProgramArguments).toHaveBeenCalledWith(
      expect.objectContaining({
        wrapperPath,
      }),
    );
    expect(mocks.buildServiceEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          OPENCLAW_WRAPPER: wrapperPath,
        }),
      }),
    );
    expect(plan.environment.OPENCLAW_WRAPPER).toBe(wrapperPath);
  });

  it("tracks safe config env keys without embedding literal values", async () => {
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        HOME: "/Users/service",
        OPENCLAW_PORT: "3000",
      },
    });

    const plan = await buildGatewayInstallPlan({
      env: isolatedPlanEnv(),
      port: 3000,
      runtime: "node",
      config: {
        env: {
          HOME: "/Users/config",
          CUSTOM_VAR: "custom-value",
          EMPTY_KEY: "",
          TRIMMED_KEY: "  ",
          vars: {
            GOOGLE_API_KEY: "test-key", // pragma: allowlist secret
            OPENCLAW_PORT: "9999",
            NODE_OPTIONS: "--require /tmp/evil.js",
            SAFE_KEY: "safe-value",
          },
        },
      },
    });

    expect(plan.environment.GOOGLE_API_KEY).toBeUndefined();
    expect(plan.environment.CUSTOM_VAR).toBeUndefined();
    expect(plan.environment.SAFE_KEY).toBeUndefined();
    expect(plan.environment.NODE_OPTIONS).toBeUndefined();
    expect(plan.environment.EMPTY_KEY).toBeUndefined();
    expect(plan.environment.TRIMMED_KEY).toBeUndefined();
    expect(plan.environment.HOME).toBe("/Users/service");
    expect(plan.environment.OPENCLAW_PORT).toBe("3000");
    expect(plan.environment.OPENCLAW_SERVICE_MANAGED_ENV_KEYS).toBe(
      "CUSTOM_VAR,GOOGLE_API_KEY,SAFE_KEY",
    );
  });

  it("includes env SecretRef values from config into the service environment", async () => {
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        OPENCLAW_PORT: "3000",
      },
    });

    const plan = await buildGatewayInstallPlan({
      env: isolatedPlanEnv({
        DISCORD_BOT_TOKEN: "discord-test-token",
      }),
      port: 3000,
      runtime: "node",
      config: {
        channels: {
          discord: {
            token: { source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" },
          },
        },
      },
    });

    expect(plan.environment.DISCORD_BOT_TOKEN).toBe("discord-test-token");
    expect(plan.environment.OPENCLAW_SERVICE_MANAGED_ENV_KEYS).toBeUndefined();
  });

  it("does not embed gateway auth SecretRef values into the service environment", async () => {
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        OPENCLAW_PORT: "3000",
      },
    });

    const plan = await buildGatewayInstallPlan({
      env: isolatedPlanEnv({
        OPENCLAW_GATEWAY_TOKEN: "gateway-test-token",
      }),
      port: 3000,
      runtime: "node",
      config: {
        gateway: {
          auth: {
            token: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" },
          },
        },
      },
    });

    expect(plan.environment.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
    expect(plan.environment.OPENCLAW_SERVICE_MANAGED_ENV_KEYS).toBeUndefined();
  });

  it("does not inline config env SecretRef values already backed by state-dir dotenv", async () => {
    await writeStateDirDotEnv("DISCORD_BOT_TOKEN=discord-dotenv-token\n", {
      stateDir: path.join(isolatedHome, ".openclaw"),
    });
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        OPENCLAW_PORT: "3000",
      },
    });

    const plan = await buildGatewayInstallPlan({
      env: isolatedPlanEnv({
        DISCORD_BOT_TOKEN: "discord-shell-token",
      }),
      port: 3000,
      runtime: "node",
      config: {
        channels: {
          discord: {
            token: { source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" },
          },
        },
      },
    });

    expect(plan.environment.DISCORD_BOT_TOKEN).toBeUndefined();
    expect(plan.environment.OPENCLAW_SERVICE_MANAGED_ENV_KEYS).toBe("DISCORD_BOT_TOKEN");
  });

  it("skips auth-profile store load when no auth-profile source exists", async () => {
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        OPENCLAW_PORT: "3000",
      },
    });
    mocks.hasAnyAuthProfileStoreSource.mockReturnValue(false);

    const plan = await buildGatewayInstallPlan({
      env: isolatedPlanEnv(),
      port: 3000,
      runtime: "node",
    });

    expect(mocks.loadAuthProfileStoreForSecretsRuntime).not.toHaveBeenCalled();
    expect(plan.environment.OPENCLAW_PORT).toBe("3000");
  });

  it("uses the provided authStore without probing auth-profile runtime", async () => {
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        OPENCLAW_PORT: "3000",
      },
    });

    const plan = await buildGatewayInstallPlan({
      env: isolatedPlanEnv({
        OPENAI_API_KEY: "sk-openai-test",
      }),
      port: 3000,
      runtime: "node",
      authStore: {
        version: 1,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          },
        },
      },
    });

    expect(plan.environment.OPENAI_API_KEY).toBe("sk-openai-test");
    expect(plan.environment.OPENCLAW_SERVICE_MANAGED_ENV_KEYS).toBeUndefined();
    expect(mocks.hasAnyAuthProfileStoreSource).not.toHaveBeenCalled();
    expect(mocks.loadAuthProfileStoreForSecretsRuntime).not.toHaveBeenCalled();
  });

  it("merges only portable auth-profile env refs into the service environment", async () => {
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        OPENCLAW_PORT: "3000",
      },
    });
    mocks.loadAuthProfileStoreForSecretsRuntime.mockReturnValue({
      version: 1,
      profiles: {
        "node:default": {
          type: "token",
          provider: "node",
          tokenRef: { source: "env", provider: "default", id: "NODE_OPTIONS" },
        },
        "git:default": {
          type: "token",
          provider: "git",
          tokenRef: { source: "env", provider: "default", id: "GIT_ASKPASS" },
        },
        "broken:default": {
          type: "token",
          provider: "broken",
          tokenRef: { source: "env", provider: "default", id: "BAD KEY" },
        },
        "openai:default": {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
        "anthropic:default": {
          type: "token",
          provider: "anthropic",
          tokenRef: { source: "env", provider: "default", id: "ANTHROPIC_TOKEN" },
        },
        "missing:default": {
          type: "token",
          provider: "missing",
          tokenRef: { source: "env", provider: "default", id: "MISSING_TOKEN" },
        },
      },
    });

    const warn = vi.fn();
    const plan = await buildGatewayInstallPlan({
      env: isolatedPlanEnv({
        NODE_OPTIONS: "--require ./pwn.js",
        GIT_ASKPASS: "/tmp/askpass.sh",
        OPENAI_API_KEY: "sk-openai-test", // pragma: allowlist secret
        ANTHROPIC_TOKEN: "ant-test-token",
      }),
      port: 3000,
      runtime: "node",
      warn,
    });

    expect(plan.environment.NODE_OPTIONS).toBeUndefined();
    expect(plan.environment.GIT_ASKPASS).toBeUndefined();
    expect(plan.environment["BAD KEY"]).toBeUndefined();
    expect(plan.environment.MISSING_TOKEN).toBeUndefined();
    expect(plan.environment.OPENAI_API_KEY).toBe("sk-openai-test");
    expect(plan.environment.ANTHROPIC_TOKEN).toBe("ant-test-token");
    expect(plan.environment.OPENCLAW_SERVICE_MANAGED_ENV_KEYS).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("NODE_OPTIONS"), "Auth profile");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("GIT_ASKPASS"), "Auth profile");
  });
});

describe("buildGatewayInstallPlan — dotenv merge", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-plan-dotenv-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("tracks .env vars with config while preserving service precedence", async () => {
    await writeStateDirDotEnv(
      "BRAVE_API_KEY=BSA-from-env\nOPENROUTER_API_KEY=or-key\nMY_KEY=from-dotenv\nHOME=/from-dotenv\n",
      {
        stateDir: path.join(tmpDir, ".openclaw"),
      },
    );
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        HOME: "/from-service",
        OPENCLAW_PORT: "3000",
      },
    });

    const plan = await buildGatewayInstallPlan({
      env: { HOME: tmpDir },
      port: 3000,
      runtime: "node",
      config: {
        env: {
          vars: {
            MY_KEY: "from-config",
          },
        },
      },
    });

    expect(plan.environment.BRAVE_API_KEY).toBeUndefined();
    expect(plan.environment.OPENROUTER_API_KEY).toBeUndefined();
    expect(plan.environment.MY_KEY).toBeUndefined();
    expect(plan.environment.HOME).toBe("/from-service");
    expect(plan.environment.OPENCLAW_PORT).toBe("3000");
    expect(plan.environment.OPENCLAW_SERVICE_MANAGED_ENV_KEYS).toBe(
      "BRAVE_API_KEY,MY_KEY,OPENROUTER_API_KEY",
    );
  });

  it("works when .env file does not exist", async () => {
    mockNodeGatewayPlanFixture({ serviceEnvironment: { OPENCLAW_PORT: "3000" } });

    const plan = await buildGatewayInstallPlan({
      env: { HOME: tmpDir },
      port: 3000,
      runtime: "node",
    });

    expect(plan.environment.OPENCLAW_PORT).toBe("3000");
  });

  it("preserves safe custom vars from an existing service env and merges PATH", async () => {
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        HOME: "/from-service",
        OPENCLAW_PORT: "3000",
        PATH: "/managed/bin:/usr/bin",
        TMPDIR: "/tmp",
      },
    });

    const plan = await buildGatewayInstallPlan({
      env: { HOME: tmpDir },
      port: 3000,
      runtime: "node",
      existingEnvironment: {
        PATH: [
          ".",
          "/tmp/evil",
          "/proc/self/cwd/evil-bin",
          "/proc/thread-self/cwd/evil-bin",
          "/proc/12345/cwd/evil-bin",
          "/proc/self/root/evil-bin",
          `${process.cwd()}/evil-bin`,
          "/custom/go/bin",
          "/usr/bin",
        ].join(path.delimiter),
        GOBIN: "/Users/test/.local/gopath/bin",
        BLOGWATCHER_HOME: "/Users/test/.blogwatcher",
        NODE_OPTIONS: "--require /tmp/evil.js",
        GOPATH: "/Users/test/.local/gopath",
        OPENCLAW_SERVICE_MARKER: "openclaw",
      },
    });

    expect(plan.environment.PATH).toBe("/managed/bin:/usr/bin:/custom/go/bin");
    expect(plan.environment.GOBIN).toBe("/Users/test/.local/gopath/bin");
    expect(plan.environment.BLOGWATCHER_HOME).toBe("/Users/test/.blogwatcher");
    expect(plan.environment.NODE_OPTIONS).toBeUndefined();
    expect(plan.environment.GOPATH).toBeUndefined();
    expect(plan.environment.OPENCLAW_SERVICE_MARKER).toBeUndefined();
  });

  it("drops existing PATH entries that resolve through symlinks into temp dirs", async () => {
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        HOME: "/from-service",
        OPENCLAW_PORT: "3000",
        PATH: "/managed/bin:/usr/bin",
        TMPDIR: "/tmp",
      },
    });
    const realpathNative = vi.spyOn(fs.realpathSync, "native").mockImplementation((candidate) => {
      const value = String(candidate);
      if (value === "/opt/safe/bin") {
        return "/tmp/evil/bin";
      }
      if (value === "/opt/safe") {
        return "/tmp/evil";
      }
      if (value === "/opt/safe/missing-bin") {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      return value;
    });

    try {
      const plan = await buildGatewayInstallPlan({
        env: { HOME: tmpDir },
        port: 3000,
        runtime: "node",
        existingEnvironment: {
          PATH: "/opt/safe/bin:/opt/safe/missing-bin:/custom/go/bin:/usr/bin",
        },
      });

      expect(plan.environment.PATH).toBe("/managed/bin:/usr/bin:/custom/go/bin");
    } finally {
      realpathNative.mockRestore();
    }
  });

  it("drops workspace-derived PATH entries even when HOME equals the install cwd", async () => {
    const cwd = process.cwd();
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        HOME: cwd,
        OPENCLAW_PORT: "3000",
        PATH: "/managed/bin:/usr/bin",
        TMPDIR: "/tmp",
      },
    });

    const plan = await buildGatewayInstallPlan({
      env: { HOME: cwd },
      port: 3000,
      runtime: "node",
      existingEnvironment: {
        PATH: `${cwd}/evil-bin:/custom/go/bin:/usr/bin`,
      },
    });

    expect(plan.environment.PATH).toBe("/managed/bin:/usr/bin:/custom/go/bin");
  });

  it("drops keys that were previously tracked as managed service env", async () => {
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        HOME: "/from-service",
        OPENCLAW_PORT: "3000",
        PATH: "/managed/bin:/usr/bin",
      },
    });

    const plan = await buildGatewayInstallPlan({
      env: { HOME: tmpDir },
      port: 3000,
      runtime: "node",
      existingEnvironment: {
        PATH: "/custom/go/bin:/usr/bin",
        GOBIN: "/Users/test/.local/gopath/bin",
        BLOGWATCHER_HOME: "/Users/test/.blogwatcher",
        GOPATH: "/Users/test/.local/gopath",
        OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "GOBIN,GOPATH",
      },
    });

    expect(plan.environment.PATH).toBe("/managed/bin:/usr/bin:/custom/go/bin");
    expect(plan.environment.GOBIN).toBeUndefined();
    expect(plan.environment.BLOGWATCHER_HOME).toBe("/Users/test/.blogwatcher");
    expect(plan.environment.GOPATH).toBeUndefined();
    expect(plan.environment.OPENCLAW_SERVICE_MANAGED_ENV_KEYS).toBeUndefined();
  });

  it("drops legacy inline env values when the key is now managed by .env", async () => {
    await writeStateDirDotEnv("TAVILY_API_KEY=fresh-dotenv-value\n", {
      stateDir: path.join(tmpDir, ".openclaw"),
    });
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        HOME: "/from-service",
        OPENCLAW_PORT: "3000",
      },
    });

    const plan = await buildGatewayInstallPlan({
      env: { HOME: tmpDir },
      port: 3000,
      runtime: "node",
      existingEnvironment: {
        TAVILY_API_KEY: "old-inline-value",
        CUSTOM_TOOL_HOME: "/Users/test/.custom-tool",
      },
    });

    expect(plan.environment.TAVILY_API_KEY).toBeUndefined();
    expect(plan.environment.OPENCLAW_SERVICE_MANAGED_ENV_KEYS).toBe("TAVILY_API_KEY");
    expect(plan.environment.CUSTOM_TOOL_HOME).toBe("/Users/test/.custom-tool");
  });

  it("does not embed auth-profile env refs when the key is already durable", async () => {
    await writeStateDirDotEnv("OPENAI_API_KEY=dotenv-openai\n", {
      stateDir: path.join(tmpDir, ".openclaw"),
    });
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        HOME: "/from-service",
        OPENCLAW_PORT: "3000",
      },
    });

    const plan = await buildGatewayInstallPlan({
      env: {
        HOME: tmpDir,
        OPENAI_API_KEY: "shell-openai",
      },
      port: 3000,
      runtime: "node",
      authStore: {
        version: 1,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          },
        },
      },
    });

    expect(plan.environment.OPENAI_API_KEY).toBeUndefined();
    expect(plan.environment.OPENCLAW_SERVICE_MANAGED_ENV_KEYS).toBe("OPENAI_API_KEY");
  });
});

describe("gatewayInstallErrorHint", () => {
  it("returns platform-specific hints", () => {
    expect(gatewayInstallErrorHint("win32")).toContain("Startup-folder login item");
    expect(gatewayInstallErrorHint("win32")).toContain("elevated PowerShell");
    expect(gatewayInstallErrorHint("linux")).toMatch(
      /(?:openclaw|openclaw)( --profile isolated)? gateway install/,
    );
  });
});
