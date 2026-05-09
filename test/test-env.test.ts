import fs from "node:fs";
import path from "node:path";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "./helpers/temp-dir.js";
import { installTestEnv } from "./test-env.js";

const ORIGINAL_ENV = { ...process.env };

const tempDirs = new Set<string>();
const cleanupFns: Array<() => void> = [];

function restoreProcessEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function writeFile(targetPath: string, content: string): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, "utf8");
}

function createTempHome(): string {
  return makeTempDir(tempDirs, "openclaw-test-env-real-home-");
}

function requireRecord(
  value: Record<string, unknown> | undefined,
  label: string,
): Record<string, unknown> {
  if (!value) {
    throw new Error(`expected copied ${label} config`);
  }
  return value;
}

function requireTelegramStreaming(
  value:
    | {
        mode?: string;
        chunkMode?: string;
        block?: { enabled?: boolean };
        preview?: { chunk?: { minChars?: number } };
      }
    | undefined,
) {
  if (!value) {
    throw new Error("expected copied telegram streaming config");
  }
  return value;
}

afterEach(() => {
  while (cleanupFns.length > 0) {
    cleanupFns.pop()?.();
  }
  restoreProcessEnv();
  cleanupTempDirs(tempDirs);
});

describe("installTestEnv", () => {
  it("keeps live tests on a temp HOME while copying config and auth state", () => {
    const realHome = createTempHome();
    const priorIsolatedHome = createTempHome();
    writeFile(path.join(realHome, ".profile"), "export TEST_PROFILE_ONLY=from-profile\n");
    writeFile(
      path.join(realHome, "custom-openclaw.json5"),
      `{
        // Preserve provider config, strip host-bound paths.
        agents: {
          defaults: {
            workspace: "/Users/peter/Projects",
            agentDir: "/Users/peter/.openclaw/agents/main/agent",
          },
          list: [
            {
              id: "dev",
              workspace: "/Users/peter/dev-workspace",
              agentDir: "/Users/peter/.openclaw/agents/dev/agent",
            },
          ],
        },
        models: {
          providers: {
            custom: { baseUrl: "https://example.test/v1" },
          },
        },
        channels: {
          telegram: {
            streaming: {
              mode: "block",
              chunkMode: "newline",
              block: {
                enabled: true,
              },
              preview: {
                chunk: {
                  minChars: 120,
                },
              },
            },
          },
        },
      }`,
    );
    writeFile(path.join(realHome, ".openclaw", "credentials", "token.txt"), "secret\n");
    writeFile(
      path.join(realHome, ".openclaw", "external-plugins", "glueclaw", "openclaw.plugin.json"),
      '{"id":"glueclaw"}\n',
    );
    writeFile(
      path.join(realHome, ".openclaw", "agents", "main", "agent", "auth-profiles.json"),
      JSON.stringify({ version: 1, profiles: { default: { provider: "openai" } } }, null, 2),
    );
    writeFile(path.join(realHome, ".claude", ".credentials.json"), '{"accessToken":"token"}\n');
    writeFile(path.join(realHome, ".claude", "projects", "old-session.jsonl"), "session\n");
    fs.mkdirSync(path.join(realHome, ".claude", "settings.local.json"), { recursive: true });
    writeFile(path.join(realHome, ".codex", "auth.json"), '{"OPENAI_API_KEY":"token"}\n');
    writeFile(path.join(realHome, ".codex", "config.toml"), 'model = "gpt-5.4"\n');
    writeFile(
      path.join(realHome, ".codex", "sessions", "2026", "02", "26", "rollout.jsonl"),
      "session\n",
    );

    process.env.HOME = realHome;
    process.env.USERPROFILE = realHome;
    process.env.OPENCLAW_LIVE_TEST = "1";
    process.env.OPENCLAW_LIVE_TEST_QUIET = "1";
    process.env.OPENCLAW_CONFIG_PATH = "~/custom-openclaw.json5";
    process.env.OPENCLAW_TEST_HOME = priorIsolatedHome;
    process.env.OPENCLAW_STATE_DIR = path.join(priorIsolatedHome, ".openclaw");

    const testEnv = installTestEnv();
    cleanupFns.push(testEnv.cleanup);

    expect(testEnv.tempHome).not.toBe(realHome);
    expect(process.env.HOME).toBe(testEnv.tempHome);
    expect(process.env.OPENCLAW_TEST_HOME).toBe(testEnv.tempHome);
    expect(process.env.TEST_PROFILE_ONLY).toBe("from-profile");

    const copiedConfigPath = path.join(testEnv.tempHome, ".openclaw", "openclaw.json");
    const copiedConfig = JSON.parse(fs.readFileSync(copiedConfigPath, "utf8")) as {
      agents?: {
        defaults?: Record<string, unknown>;
        list?: Array<Record<string, unknown>>;
      };
      models?: { providers?: Record<string, unknown> };
      channels?: {
        telegram?: {
          streaming?: {
            mode?: string;
            chunkMode?: string;
            block?: { enabled?: boolean };
            preview?: { chunk?: { minChars?: number } };
          };
        };
      };
    };
    const providers = copiedConfig.models?.providers;
    requireRecord(providers, "model providers");
    expect(providers.custom).toEqual({ baseUrl: "https://example.test/v1" });

    const agentDefaults = requireRecord(copiedConfig.agents?.defaults, "agent defaults");
    const agentConfig = requireRecord(copiedConfig.agents?.list?.[0], "agent");
    expect(agentDefaults.workspace).toBeUndefined();
    expect(agentDefaults.agentDir).toBeUndefined();
    expect(agentConfig.workspace).toBeUndefined();
    expect(agentConfig.agentDir).toBeUndefined();

    const telegramStreaming = requireTelegramStreaming(copiedConfig.channels?.telegram?.streaming);
    expect(telegramStreaming).toEqual({
      mode: "block",
      chunkMode: "newline",
      block: { enabled: true },
      preview: { chunk: { minChars: 120 } },
    });

    expect(
      fs.existsSync(path.join(testEnv.tempHome, ".openclaw", "credentials", "token.txt")),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(
          testEnv.tempHome,
          ".openclaw",
          "external-plugins",
          "glueclaw",
          "openclaw.plugin.json",
        ),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(testEnv.tempHome, ".openclaw", "agents", "main", "agent", "auth-profiles.json"),
      ),
    ).toBe(true);
    expect(fs.existsSync(path.join(testEnv.tempHome, ".claude", ".credentials.json"))).toBe(true);
    expect(fs.existsSync(path.join(testEnv.tempHome, ".claude", "projects"))).toBe(false);
    expect(fs.existsSync(path.join(testEnv.tempHome, ".claude", "settings.local.json"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(testEnv.tempHome, ".codex", "auth.json"))).toBe(true);
    expect(fs.existsSync(path.join(testEnv.tempHome, ".codex", "config.toml"))).toBe(true);
    expect(fs.existsSync(path.join(testEnv.tempHome, ".codex", "sessions"))).toBe(false);
  });

  it("allows explicit live runs against the real HOME", () => {
    const realHome = createTempHome();
    writeFile(path.join(realHome, ".profile"), "export TEST_PROFILE_ONLY=from-profile\n");

    process.env.HOME = realHome;
    process.env.USERPROFILE = realHome;
    process.env.OPENCLAW_LIVE_TEST = "1";
    process.env.OPENCLAW_LIVE_USE_REAL_HOME = "1";
    process.env.OPENCLAW_LIVE_TEST_QUIET = "1";

    const testEnv = installTestEnv();

    expect(testEnv.tempHome).toBe(realHome);
    expect(process.env.HOME).toBe(realHome);
    expect(process.env.TEST_PROFILE_ONLY).toBe("from-profile");
  });

  it("does not load ~/.profile for normal isolated test runs", () => {
    const realHome = createTempHome();
    writeFile(path.join(realHome, ".profile"), "export TEST_PROFILE_ONLY=from-profile\n");

    process.env.HOME = realHome;
    process.env.USERPROFILE = realHome;
    delete process.env.LIVE;
    delete process.env.OPENCLAW_LIVE_TEST;
    delete process.env.OPENCLAW_LIVE_GATEWAY;
    delete process.env.OPENCLAW_LIVE_USE_REAL_HOME;
    delete process.env.OPENCLAW_LIVE_TEST_QUIET;

    const testEnv = installTestEnv();
    cleanupFns.push(testEnv.cleanup);

    expect(testEnv.tempHome).not.toBe(realHome);
    expect(process.env.TEST_PROFILE_ONLY).toBeUndefined();
  });

  it("falls back to parsing ~/.profile when bash is unavailable", async () => {
    const realHome = createTempHome();
    writeFile(path.join(realHome, ".profile"), "export TEST_PROFILE_ONLY=from-profile\n");

    process.env.HOME = realHome;
    process.env.USERPROFILE = realHome;
    process.env.OPENCLAW_LIVE_TEST = "1";
    process.env.OPENCLAW_LIVE_USE_REAL_HOME = "1";
    process.env.OPENCLAW_LIVE_TEST_QUIET = "1";

    vi.doMock("node:child_process", () => ({
      execFileSync: () => {
        throw Object.assign(new Error("bash missing"), { code: "ENOENT" });
      },
    }));

    const { installTestEnv: installFreshTestEnv } = await importFreshModule<
      typeof import("./test-env.js")
    >(import.meta.url, "./test-env.js?scope=profile-fallback");

    const testEnv = installFreshTestEnv();

    expect(testEnv.tempHome).toBe(realHome);
    expect(process.env.TEST_PROFILE_ONLY).toBe("from-profile");
  });
});
