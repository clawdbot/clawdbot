import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadCliDotEnv } from "../cli/dotenv.js";
import { loadDotEnv, loadWorkspaceDotEnvFile } from "./dotenv.js";

const CREDENTIAL_AND_GATEWAY_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_API_KEY_SECONDARY",
  "ANTHROPIC_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_API_KEYS",
  "OPENAI_API_KEY_SECONDARY",
  "OPENCLAW_LIVE_ANTHROPIC_KEY",
  "OPENCLAW_LIVE_ANTHROPIC_KEYS",
  "OPENCLAW_LIVE_GEMINI_KEY",
  "OPENCLAW_LIVE_OPENAI_KEY",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_GATEWAY_PASSWORD",
  "OPENCLAW_GATEWAY_SECRET",
] as const;

const BUNDLED_TRUST_ROOT_ENV_LINES = [
  "OPENCLAW_BROWSER_CONTROL_MODULE=data:text/javascript,boom",
  "OPENCLAW_BUNDLED_HOOKS_DIR=./attacker-hooks",
  "OPENCLAW_BUNDLED_PLUGINS_DIR=./attacker-plugins",
  "OPENCLAW_BUNDLED_SKILLS_DIR=./attacker-skills",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER=1",
] as const;

const BUNDLED_TRUST_ROOT_ENV_KEYS = BUNDLED_TRUST_ROOT_ENV_LINES.map(
  (line) => line.split("=")[0] ?? "",
);

async function writeEnvFile(filePath: string, contents: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
}

function clearEnv(keys: readonly string[]) {
  for (const key of keys) {
    delete process.env[key];
  }
}

function expectEnvUndefined(keys: readonly string[]) {
  for (const key of keys) {
    expect(process.env[key]).toBeUndefined();
  }
}

async function withIsolatedEnvAndCwd(run: () => Promise<void>) {
  const prevEnv = { ...process.env };
  try {
    await run();
  } finally {
    vi.restoreAllMocks();
    for (const key of Object.keys(process.env)) {
      if (!(key in prevEnv)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

type DotEnvFixture = {
  base: string;
  cwdDir: string;
  stateDir: string;
};

async function withDotEnvFixture(run: (fixture: DotEnvFixture) => Promise<void>) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dotenv-test-"));
  const cwdDir = path.join(base, "cwd");
  const stateDir = path.join(base, "state");
  process.env.OPENCLAW_STATE_DIR = stateDir;
  await fs.mkdir(cwdDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await run({ base, cwdDir, stateDir });
}

describe("loadDotEnv", () => {
  it("loads ~/.openclaw/.env as fallback without overriding CWD .env", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir, stateDir }) => {
        await writeEnvFile(path.join(stateDir, ".env"), "FOO=from-global\nBAR=1\n");
        await writeEnvFile(path.join(cwdDir, ".env"), "FOO=from-cwd\n");

        vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
        delete process.env.FOO;
        delete process.env.BAR;

        loadDotEnv({ quiet: true });

        expect(process.env.FOO).toBe("from-cwd");
        expect(process.env.BAR).toBe("1");
      });
    });
  });

  it("does not override an already-set env var from the shell", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir, stateDir }) => {
        process.env.FOO = "from-shell";

        await writeEnvFile(path.join(stateDir, ".env"), "FOO=from-global\n");
        await writeEnvFile(path.join(cwdDir, ".env"), "FOO=from-cwd\n");

        vi.spyOn(process, "cwd").mockReturnValue(cwdDir);

        loadDotEnv({ quiet: true });

        expect(process.env.FOO).toBe("from-shell");
      });
    });
  });

  it("loads fallback state .env when CWD .env is missing", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir, stateDir }) => {
        await writeEnvFile(path.join(stateDir, ".env"), "FOO=from-global\n");
        vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
        delete process.env.FOO;

        loadDotEnv({ quiet: true });

        expect(process.env.FOO).toBe("from-global");
      });
    });
  });

  it("loads the Ubuntu gateway.env compatibility fallback after ~/.openclaw/.env", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ base, cwdDir }) => {
        process.env.HOME = base;
        const defaultStateDir = path.join(base, ".openclaw");
        process.env.OPENCLAW_STATE_DIR = defaultStateDir;
        await writeEnvFile(path.join(defaultStateDir, ".env"), "FOO=from-global\n");
        await writeEnvFile(
          path.join(base, ".config", "openclaw", "gateway.env"),
          ["FOO=from-gateway", "BAR=from-gateway"].join("\n"),
        );

        vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
        delete process.env.FOO;
        delete process.env.BAR;
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        loadDotEnv({ quiet: true });

        expect(process.env.FOO).toBe("from-global");
        expect(process.env.BAR).toBe("from-gateway");
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("Conflicting values in"));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("gateway.env"));
      });
    });
  });

  it("does not warn about dotenv conflicts when the key is already set", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ base, cwdDir, stateDir }) => {
        process.env.HOME = base;
        process.env.FOO = "from-shell";
        await writeEnvFile(path.join(stateDir, ".env"), "FOO=from-global\n");
        await writeEnvFile(
          path.join(base, ".config", "openclaw", "gateway.env"),
          "FOO=from-gateway\n",
        );

        vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        loadDotEnv({ quiet: true });

        expect(process.env.FOO).toBe("from-shell");
        expect(warn).not.toHaveBeenCalled();
      });
    });
  });

  it("blocks dangerous and workspace-control vars from CWD .env", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir, stateDir }) => {
        await writeEnvFile(
          path.join(cwdDir, ".env"),
          [
            "SAFE_KEY=from-cwd",
            "NODE_OPTIONS=--require ./evil.js",
            "OPENCLAW_STATE_DIR=./evil-state",
            "OPENCLAW_CONFIG_PATH=./evil-config.json",
            "ANTHROPIC_BASE_URL=https://evil.example.com/v1",
            "EXAMPLE_API_HOST=https://evil-api.example.com",
            "MINIMAX_API_HOST=https://evil.example.com",
            "HTTP_PROXY=http://evil-proxy:8080",
            "UV_PYTHON=./attacker-python",
            "uv_python=./attacker-python-lower",
          ].join("\n"),
        );
        await writeEnvFile(path.join(stateDir, ".env"), "BAR=from-global\n");

        vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
        delete process.env.SAFE_KEY;
        delete process.env.NODE_OPTIONS;
        delete process.env.OPENCLAW_CONFIG_PATH;
        delete process.env.ANTHROPIC_BASE_URL;
        delete process.env.EXAMPLE_API_HOST;
        delete process.env.MINIMAX_API_HOST;
        delete process.env.HTTP_PROXY;
        delete process.env.UV_PYTHON;
        delete process.env.uv_python;

        loadDotEnv({ quiet: true });

        expect(process.env.SAFE_KEY).toBe("from-cwd");
        expect(process.env.BAR).toBe("from-global");
        expect(process.env.NODE_OPTIONS).toBeUndefined();
        expect(process.env.OPENCLAW_STATE_DIR).toBe(stateDir);
        expect(process.env.OPENCLAW_CONFIG_PATH).toBeUndefined();
        expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
        expect(process.env.EXAMPLE_API_HOST).toBeUndefined();
        expect(process.env.MINIMAX_API_HOST).toBeUndefined();
        expect(process.env.HTTP_PROXY).toBeUndefined();
        expect(process.env.UV_PYTHON).toBeUndefined();
        expect(process.env.uv_python).toBeUndefined();
      });
    });
  });

  it("blocks credential and gateway auth vars from CWD .env", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir }) => {
        await writeEnvFile(
          path.join(cwdDir, ".env"),
          [
            "ANTHROPIC_API_KEY=sk-ant-attacker-key",
            "ANTHROPIC_API_KEY_SECONDARY=sk-ant-secondary",
            "ANTHROPIC_OAUTH_TOKEN=attacker-oauth",
            "OPENAI_API_KEY=sk-openai-attacker-key",
            "OPENAI_API_KEYS=sk-openai-a,sk-openai-b",
            "OPENAI_API_KEY_SECONDARY=sk-openai-secondary",
            "OPENCLAW_LIVE_ANTHROPIC_KEY=sk-ant-live",
            "OPENCLAW_LIVE_ANTHROPIC_KEYS=sk-ant-live-a,sk-ant-live-b",
            "OPENCLAW_LIVE_GEMINI_KEY=sk-gemini-live",
            "OPENCLAW_LIVE_OPENAI_KEY=sk-openai-live",
            "OPENCLAW_GATEWAY_TOKEN=attacker-token",
            "OPENCLAW_GATEWAY_PASSWORD=attacker-password",
            "OPENCLAW_GATEWAY_SECRET=attacker-secret",
          ].join("\n"),
        );

        clearEnv(CREDENTIAL_AND_GATEWAY_ENV_KEYS);

        loadWorkspaceDotEnvFile(path.join(cwdDir, ".env"), { quiet: true });

        expectEnvUndefined(CREDENTIAL_AND_GATEWAY_ENV_KEYS);
      });
    });
  });

  it("blocks OPENCLAW_STATE_DIR from workspace .env even when unset in process env", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir }) => {
        await writeEnvFile(
          path.join(cwdDir, ".env"),
          "OPENCLAW_STATE_DIR=./evil-state\nOPENCLAW_CONFIG_PATH=./evil-config.json\n",
        );

        delete process.env.OPENCLAW_STATE_DIR;
        delete process.env.OPENCLAW_CONFIG_PATH;

        loadWorkspaceDotEnvFile(path.join(cwdDir, ".env"), { quiet: true });

        expect(process.env.OPENCLAW_STATE_DIR).toBeUndefined();
        expect(process.env.OPENCLAW_CONFIG_PATH).toBeUndefined();
      });
    });
  });

  it("blocks path-override vars (OPENCLAW_AGENT_DIR, OPENCLAW_BUNDLED_PLUGINS_DIR, PI_CODING_AGENT_DIR, OPENCLAW_OAUTH_DIR) from workspace .env", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ base, cwdDir }) => {
        const bundledPluginsDir = path.join(base, "attacker-bundled");
        await writeEnvFile(
          path.join(cwdDir, ".env"),
          [
            "OPENCLAW_AGENT_DIR=./evil-agent",
            `OPENCLAW_BUNDLED_PLUGINS_DIR=${bundledPluginsDir}`,
            "PI_CODING_AGENT_DIR=./evil-coding",
            "OPENCLAW_OAUTH_DIR=./evil-oauth",
          ].join("\n"),
        );

        delete process.env.OPENCLAW_AGENT_DIR;
        delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
        delete process.env.PI_CODING_AGENT_DIR;
        delete process.env.OPENCLAW_OAUTH_DIR;

        loadWorkspaceDotEnvFile(path.join(cwdDir, ".env"), { quiet: true });

        expect(process.env.OPENCLAW_AGENT_DIR).toBeUndefined();
        expect(process.env.OPENCLAW_BUNDLED_PLUGINS_DIR).toBeUndefined();
        expect(process.env.PI_CODING_AGENT_DIR).toBeUndefined();
        expect(process.env.OPENCLAW_OAUTH_DIR).toBeUndefined();
      });
    });
  });

  it("blocks OPENCLAW_TEST_TAILSCALE_BINARY from workspace .env", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir }) => {
        await writeEnvFile(
          path.join(cwdDir, ".env"),
          "OPENCLAW_TEST_TAILSCALE_BINARY=/tmp/attacker-tailscale\n",
        );

        delete process.env.OPENCLAW_TEST_TAILSCALE_BINARY;

        loadWorkspaceDotEnvFile(path.join(cwdDir, ".env"), { quiet: true });

        expect(process.env.OPENCLAW_TEST_TAILSCALE_BINARY).toBeUndefined();
      });
    });
  });

  it("blocks pinned helper interpreter vars from workspace .env", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir }) => {
        await writeEnvFile(
          path.join(cwdDir, ".env"),
          [
            "OPENCLAW_PINNED_PYTHON=./attacker-python",
            "OPENCLAW_PINNED_WRITE_PYTHON=./attacker-write-python",
          ].join("\n"),
        );

        delete process.env.OPENCLAW_PINNED_PYTHON;
        delete process.env.OPENCLAW_PINNED_WRITE_PYTHON;

        loadWorkspaceDotEnvFile(path.join(cwdDir, ".env"), { quiet: true });

        expect(process.env.OPENCLAW_PINNED_PYTHON).toBeUndefined();
        expect(process.env.OPENCLAW_PINNED_WRITE_PYTHON).toBeUndefined();
      });
    });
  });

  it("blocks bundled trust-root vars from workspace .env", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir }) => {
        await writeEnvFile(path.join(cwdDir, ".env"), [...BUNDLED_TRUST_ROOT_ENV_LINES].join("\n"));

        clearEnv(BUNDLED_TRUST_ROOT_ENV_KEYS);

        loadWorkspaceDotEnvFile(path.join(cwdDir, ".env"), { quiet: true });

        expectEnvUndefined(BUNDLED_TRUST_ROOT_ENV_KEYS);
      });
    });
  });

  it("still allows trusted global .env to set non-workspace runtime vars", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir, stateDir }) => {
        await writeEnvFile(
          path.join(stateDir, ".env"),
          [
            "ANTHROPIC_BASE_URL=https://trusted.example.com/v1",
            "HTTP_PROXY=http://proxy.test:8080",
            "OPENCLAW_PINNED_PYTHON=/trusted/python",
            "OPENCLAW_PINNED_WRITE_PYTHON=/trusted/write-python",
          ].join("\n"),
        );
        vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
        delete process.env.ANTHROPIC_BASE_URL;
        delete process.env.HTTP_PROXY;
        delete process.env.OPENCLAW_PINNED_PYTHON;
        delete process.env.OPENCLAW_PINNED_WRITE_PYTHON;

        loadDotEnv({ quiet: true });

        expect(process.env.ANTHROPIC_BASE_URL).toBe("https://trusted.example.com/v1");
        expect(process.env.HTTP_PROXY).toBe("http://proxy.test:8080");
        expect(process.env.OPENCLAW_PINNED_PYTHON).toBe("/trusted/python");
        expect(process.env.OPENCLAW_PINNED_WRITE_PYTHON).toBe("/trusted/write-python");
      });
    });
  });

  it("still allows trusted global .env to set credential and gateway auth vars", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir, stateDir }) => {
        await writeEnvFile(
          path.join(stateDir, ".env"),
          [
            "ANTHROPIC_API_KEY=sk-ant-trusted-key",
            "ANTHROPIC_API_KEY_SECONDARY=sk-ant-secondary",
            "ANTHROPIC_OAUTH_TOKEN=trusted-oauth",
            "OPENAI_API_KEY=sk-openai-trusted-key",
            "OPENAI_API_KEYS=sk-openai-a,sk-openai-b",
            "OPENAI_API_KEY_SECONDARY=sk-openai-secondary",
            "OPENCLAW_LIVE_ANTHROPIC_KEY=sk-ant-live",
            "OPENCLAW_LIVE_ANTHROPIC_KEYS=sk-ant-live-a,sk-ant-live-b",
            "OPENCLAW_LIVE_GEMINI_KEY=sk-gemini-live",
            "OPENCLAW_LIVE_OPENAI_KEY=sk-openai-live",
            "OPENCLAW_GATEWAY_TOKEN=trusted-token",
            "OPENCLAW_GATEWAY_PASSWORD=trusted-password",
            "OPENCLAW_GATEWAY_SECRET=trusted-secret",
          ].join("\n"),
        );
        vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
        clearEnv(CREDENTIAL_AND_GATEWAY_ENV_KEYS);

        loadDotEnv({ quiet: true });

        expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-trusted-key");
        expect(process.env.ANTHROPIC_API_KEY_SECONDARY).toBe("sk-ant-secondary");
        expect(process.env.ANTHROPIC_OAUTH_TOKEN).toBe("trusted-oauth");
        expect(process.env.OPENAI_API_KEY).toBe("sk-openai-trusted-key");
        expect(process.env.OPENAI_API_KEYS).toBe("sk-openai-a,sk-openai-b");
        expect(process.env.OPENAI_API_KEY_SECONDARY).toBe("sk-openai-secondary");
        expect(process.env.OPENCLAW_LIVE_ANTHROPIC_KEY).toBe("sk-ant-live");
        expect(process.env.OPENCLAW_LIVE_ANTHROPIC_KEYS).toBe("sk-ant-live-a,sk-ant-live-b");
        expect(process.env.OPENCLAW_LIVE_GEMINI_KEY).toBe("sk-gemini-live");
        expect(process.env.OPENCLAW_LIVE_OPENAI_KEY).toBe("sk-openai-live");
        expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("trusted-token");
        expect(process.env.OPENCLAW_GATEWAY_PASSWORD).toBe("trusted-password");
        expect(process.env.OPENCLAW_GATEWAY_SECRET).toBe("trusted-secret");
      });
    });
  });

  it("does not let CWD .env redirect which global .env is loaded", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ base, cwdDir, stateDir }) => {
        const evilStateDir = path.join(base, "evil-state");
        await writeEnvFile(path.join(cwdDir, ".env"), "OPENCLAW_STATE_DIR=./evil-state\n");
        await writeEnvFile(path.join(stateDir, ".env"), "SAFE_KEY=trusted-global\n");
        await writeEnvFile(path.join(evilStateDir, ".env"), "SAFE_KEY=evil-global\n");

        vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
        delete process.env.SAFE_KEY;

        loadDotEnv({ quiet: true });

        expect(process.env.OPENCLAW_STATE_DIR).toBe(stateDir);
        expect(process.env.SAFE_KEY).toBe("trusted-global");
      });
    });
  });
});

describe("loadCliDotEnv", () => {
  it("blocks OPENCLAW_STATE_DIR from workspace .env even when unset in process env", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir }) => {
        await writeEnvFile(path.join(cwdDir, ".env"), "OPENCLAW_STATE_DIR=./evil-state\n");

        // Delete the fixture-provided value so the blocking must come from
        // the workspace blocklist, not the "already set" skip.
        delete process.env.OPENCLAW_STATE_DIR;
        vi.spyOn(process, "cwd").mockReturnValue(cwdDir);

        loadCliDotEnv({ quiet: true });

        expect(process.env.OPENCLAW_STATE_DIR).toBeUndefined();
      });
    });
  });

  it("loads the gateway.env compatibility fallback during CLI startup", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ base, cwdDir }) => {
        process.env.HOME = base;
        const defaultStateDir = path.join(base, ".openclaw");
        process.env.OPENCLAW_STATE_DIR = defaultStateDir;
        await writeEnvFile(path.join(defaultStateDir, ".env"), "FOO=from-global\n");
        await writeEnvFile(
          path.join(base, ".config", "openclaw", "gateway.env"),
          "BAR=from-gateway\n",
        );

        vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
        delete process.env.FOO;
        delete process.env.BAR;

        loadCliDotEnv({ quiet: true });

        expect(process.env.FOO).toBe("from-global");
        expect(process.env.BAR).toBe("from-gateway");
      });
    });
  });

  it("does not load gateway.env when OPENCLAW_STATE_DIR is explicitly set", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ base, cwdDir }) => {
        const customStateDir = path.join(base, "custom-state");
        process.env.HOME = base;
        process.env.OPENCLAW_STATE_DIR = customStateDir;
        await writeEnvFile(
          path.join(base, ".config", "openclaw", "gateway.env"),
          "FOO=from-gateway\n",
        );

        vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
        delete process.env.FOO;

        loadCliDotEnv({ quiet: true });

        expect(process.env.FOO).toBeUndefined();
        expect(process.env.OPENCLAW_STATE_DIR).toBe(customStateDir);
        expect(process.env.BAR).toBeUndefined();
      });
    });
  });

  it("keeps the legacy state-dir fallback for CLI dotenv loading", async () => {
    await withIsolatedEnvAndCwd(async () => {
      const base = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dotenv-legacy-"));
      const cwdDir = path.join(base, "cwd");
      const legacyStateDir = path.join(base, ".clawdbot");
      process.env.HOME = base;
      delete process.env.OPENCLAW_STATE_DIR;
      delete process.env.OPENCLAW_TEST_FAST;
      await fs.mkdir(cwdDir, { recursive: true });
      await writeEnvFile(path.join(legacyStateDir, ".env"), "LEGACY_ONLY=from-legacy\n");

      vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
      delete process.env.LEGACY_ONLY;

      loadCliDotEnv({ quiet: true });

      expect(process.env.LEGACY_ONLY).toBe("from-legacy");
    });
  });

  it("blocks bundled trust-root vars from workspace .env during CLI startup", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir }) => {
        await writeEnvFile(path.join(cwdDir, ".env"), [...BUNDLED_TRUST_ROOT_ENV_LINES].join("\n"));

        clearEnv(BUNDLED_TRUST_ROOT_ENV_KEYS);
        vi.spyOn(process, "cwd").mockReturnValue(cwdDir);

        loadCliDotEnv({ quiet: true });

        expectEnvUndefined(BUNDLED_TRUST_ROOT_ENV_KEYS);
      });
    });
  });

  it("blocks workspace .env takeover vars before loading the global fallback", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ base, cwdDir, stateDir }) => {
        const bundledPluginsDir = path.join(base, "attacker-bundled");
        await writeEnvFile(
          path.join(cwdDir, ".env"),
          [
            "SAFE_KEY=from-cwd",
            "OPENCLAW_STATE_DIR=./evil-state",
            "OPENCLAW_CONFIG_PATH=./evil-config.json",
            `OPENCLAW_BUNDLED_PLUGINS_DIR=${bundledPluginsDir}`,
            "NODE_OPTIONS=--require ./evil.js",
            "ANTHROPIC_BASE_URL=https://evil.example.com/v1",
            "UV_PYTHON=./attacker-python",
            "uv_python=./attacker-python-lower",
          ].join("\n"),
        );
        await writeEnvFile(path.join(stateDir, ".env"), "BAR=from-global\n");

        vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
        delete process.env.SAFE_KEY;
        delete process.env.OPENCLAW_CONFIG_PATH;
        delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
        delete process.env.NODE_OPTIONS;
        delete process.env.ANTHROPIC_BASE_URL;
        delete process.env.UV_PYTHON;
        delete process.env.uv_python;
        delete process.env.BAR;

        loadCliDotEnv({ quiet: true });

        expect(process.env.SAFE_KEY).toBe("from-cwd");
        expect(process.env.BAR).toBe("from-global");
        expect(process.env.OPENCLAW_STATE_DIR).toBe(stateDir);
        expect(process.env.OPENCLAW_CONFIG_PATH).toBeUndefined();
        expect(process.env.OPENCLAW_BUNDLED_PLUGINS_DIR).toBeUndefined();
        expect(process.env.NODE_OPTIONS).toBeUndefined();
        expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
        expect(process.env.UV_PYTHON).toBeUndefined();
        expect(process.env.uv_python).toBeUndefined();
      });
    });
  });
});

describe("workspace .env blocklist completeness", () => {
  it("blocks runtime-control variables from workspace .env", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir }) => {
        const runtimeControlKeys = [
          "OPENCLAW_GIT_DIR",
          "OPENCLAW_WORKSPACE_DIR",
          "OPENCLAW_MDNS_HOSTNAME",
          "OPENCLAW_SESSION_CACHE_TTL_MS",
          "OPENCLAW_UPDATE_PACKAGE_SPEC",
          "OPENCLAW_GATEWAY_PORT",
          "OPENCLAW_GATEWAY_URL",
          "OPENCLAW_CLAWHUB_URL",
          "CLAWHUB_URL",
          "OPENCLAW_CLAWHUB_TOKEN",
          "CLAWHUB_TOKEN",
          "CLAWHUB_AUTH_TOKEN",
          "CLAWHUB_CONFIG_PATH",
          "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
          "OPENCLAW_ALLOW_INSECURE_PRIVATE_WS",
          "OPENCLAW_BROWSER_EXECUTABLE_PATH",
          "EXAMPLE_API_HOST",
          "MINIMAX_API_HOST",
          "BROWSER_EXECUTABLE_PATH",
          "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH",
          "OPENCLAW_SKIP_CHANNELS",
          "OPENCLAW_SKIP_PROVIDERS",
          "OPENCLAW_SKIP_CRON",
          "OPENCLAW_RAW_STREAM",
          "OPENCLAW_RAW_STREAM_PATH",
          "OPENCLAW_CACHE_TRACE",
          "OPENCLAW_CACHE_TRACE_FILE",
          "OPENCLAW_CACHE_TRACE_MESSAGES",
          "OPENCLAW_CACHE_TRACE_PROMPT",
          "OPENCLAW_CACHE_TRACE_SYSTEM",
          "OPENCLAW_SHOW_SECRETS",
          "OPENCLAW_PLUGIN_CATALOG_PATHS",
          "OPENCLAW_MPM_CATALOG_PATHS",
          "OPENCLAW_NODE_EXEC_HOST",
          "OPENCLAW_NODE_EXEC_FALLBACK",
          "OPENCLAW_ALLOW_PROJECT_LOCAL_BIN",
        ];

        await writeEnvFile(
          path.join(cwdDir, ".env"),
          `${runtimeControlKeys.map((key) => `${key}=INJECTED_${key}`).join("\n")}\n`,
        );

        for (const key of runtimeControlKeys) {
          delete process.env[key];
        }

        loadWorkspaceDotEnvFile(path.join(cwdDir, ".env"), { quiet: true });

        for (const key of runtimeControlKeys) {
          expect(process.env[key], `${key} should be blocked by workspace .env`).toBeUndefined();
        }
      });
    });
  });

  it("still allows user-defined non-control vars through workspace .env", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir }) => {
        await writeEnvFile(
          path.join(cwdDir, ".env"),
          "MY_APP_KEY=user-value\nAPP_GITHUB_REPO=openclaw/openclaw\nDATABASE_URL_CUSTOM=pg://localhost\n",
        );

        delete process.env.MY_APP_KEY;
        delete process.env.APP_GITHUB_REPO;
        delete process.env.DATABASE_URL_CUSTOM;

        loadWorkspaceDotEnvFile(path.join(cwdDir, ".env"), { quiet: true });

        expect(process.env.MY_APP_KEY).toBe("user-value");
        expect(process.env.APP_GITHUB_REPO).toBe("openclaw/openclaw");
        expect(process.env.DATABASE_URL_CUSTOM).toBe("pg://localhost");
      });
    });
  });

  it("blocks generic endpoint-routing suffixes from workspace .env", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir }) => {
        await writeEnvFile(
          path.join(cwdDir, ".env"),
          [
            "FUTURE_PROVIDER_API_HOST=https://evil.example.com",
            "FUTURE_PROVIDER_BASE_URL=https://evil.example.com/v1",
            "SAFE_PROVIDER_URL=https://allowed.example.com",
          ].join("\n"),
        );

        delete process.env.FUTURE_PROVIDER_API_HOST;
        delete process.env.FUTURE_PROVIDER_BASE_URL;
        delete process.env.SAFE_PROVIDER_URL;

        loadWorkspaceDotEnvFile(path.join(cwdDir, ".env"), { quiet: true });

        expect(process.env.FUTURE_PROVIDER_API_HOST).toBeUndefined();
        expect(process.env.FUTURE_PROVIDER_BASE_URL).toBeUndefined();
        expect(process.env.SAFE_PROVIDER_URL).toBe("https://allowed.example.com");
      });
    });
  });
});
