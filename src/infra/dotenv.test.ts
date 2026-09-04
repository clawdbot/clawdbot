// Tests dotenv file loading and environment merge behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it, vi } from "vitest";
import { loadCliDotEnv } from "../cli/dotenv.js";
import { captureFullEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { loadGlobalRuntimeDotEnvFiles } from "./dotenv-global.js";
import { loadDotEnv, loadWorkspaceDotEnvFile } from "./dotenv.js";

const loggerMocks = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => loggerMocks),
}));

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

const WINDOWS_SHELL_TRUST_ROOT_ENV_KEYS = [
  "AppData",
  "APPDATA",
  "ComSpec",
  "COMSPEC",
  "LocalAppData",
  "LOCALAPPDATA",
  "ProgramFiles",
  "PROGRAMFILES",
  "ProgramW6432",
  "PROGRAMW6432",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "WINDIR",
] as const;

async function writeEnvFile(filePath: string, contents: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
}

function clearEnv(keys: readonly string[]) {
  for (const key of keys) {
    deleteTestEnvValue(key);
  }
}

function expectEnvUndefined(keys: readonly string[]) {
  for (const key of keys) {
    expect(process.env[key]).toBeUndefined();
  }
}

async function withIsolatedEnvAndCwd(run: () => Promise<void>) {
  const envSnapshot = captureFullEnv();
  try {
    await run();
  } finally {
    vi.restoreAllMocks();
    envSnapshot.restore();
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
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
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

  it("lets the state dotenv replace only explicitly service-managed inherited values", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ stateDir }) => {
        const stateEnvPath = path.join(stateDir, ".env");
        await writeEnvFile(
          stateEnvPath,
          "MANAGED_API_KEY=from-state\nOPERATOR_API_KEY=from-state\n",
        );
        process.env.MANAGED_API_KEY = "stale-service-value";
        process.env.OPERATOR_API_KEY = "operator-service-value";

        const loaded = loadGlobalRuntimeDotEnvFiles({
          stateEnvPath,
          overrideKeys: ["MANAGED_API_KEY"],
          quiet: true,
        });

        expect(process.env.MANAGED_API_KEY).toBe("from-state");
        expect(process.env.OPERATOR_API_KEY).toBe("operator-service-value");
        expect(loaded.dotenvPresentKeys).toEqual(["MANAGED_API_KEY", "OPERATOR_API_KEY"]);
      });
    });
  });

  it("matches service-managed dotenv override keys case-insensitively", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ stateDir }) => {
        const stateEnvPath = path.join(stateDir, ".env");
        await writeEnvFile(stateEnvPath, "hass_token=from-state\n");
        process.env.HASS_TOKEN = "stale-uppercase-service-value";
        process.env.hass_token = "stale-lowercase-service-value";

        loadGlobalRuntimeDotEnvFiles({
          stateEnvPath,
          overrideKeys: ["HASS_TOKEN"],
          quiet: true,
        });

        expect(process.env.HASS_TOKEN).toBe("from-state");
        expect(process.env.hass_token).toBe("from-state");
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

  it("loads global env when the working directory was deleted", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ stateDir }) => {
        await writeEnvFile(path.join(stateDir, ".env"), "FOO=from-global\n");
        vi.spyOn(process, "cwd").mockImplementation(() => {
          throw new Error("ENOENT: uv_cwd");
        });
        delete process.env.FOO;

        loadDotEnv({ quiet: true });

        expect(process.env.FOO).toBe("from-global");
      });
    });
  });

  it("loads the Ubuntu gateway.env compatibility fallback after ~/.openclaw/.env", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ base, cwdDir }) => {
        setTestEnvValue("HOME", base);
        const defaultStateDir = path.join(base, ".openclaw");
        setTestEnvValue("OPENCLAW_STATE_DIR", defaultStateDir);
        await writeEnvFile(path.join(defaultStateDir, ".env"), "FOO=from-global\n");
        await writeEnvFile(
          path.join(base, ".config", "openclaw", "gateway.env"),
          ["FOO=from-gateway", "BAR=from-gateway"].join("\n"),
        );

        vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
        delete process.env.FOO;
        delete process.env.BAR;
        loggerMocks.warn.mockClear();

        loadDotEnv({ quiet: true });

        expect(process.env.FOO).toBe("from-global");
        expect(process.env.BAR).toBe("from-gateway");
        expect(loggerMocks.warn).toHaveBeenCalledOnce();
        const [message, metadata] = expectDefined(
          loggerMocks.warn.mock.calls[0],
          "logger warning call",
        );
        expect(String(message)).toContain("Conflicting values in");
        expect(String((metadata as { ignoredPath?: unknown } | undefined)?.ignoredPath)).toContain(
          "gateway.env",
        );
      });
    });
  });

  it("does not warn about dotenv conflicts when the key is already set", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ base, cwdDir, stateDir }) => {
        setTestEnvValue("HOME", base);
        process.env.FOO = "from-shell";
        await writeEnvFile(path.join(stateDir, ".env"), "FOO=from-global\n");
        await writeEnvFile(
          path.join(base, ".config", "openclaw", "gateway.env"),
          "FOO=from-gateway\n",
        );

        vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
        loggerMocks.warn.mockClear();

        loadDotEnv({ quiet: true });

        expect(process.env.FOO).toBe("from-shell");
        expect(loggerMocks.warn).not.toHaveBeenCalled();
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
            "NODE_REDIRECT_WARNINGS=./warnings.log",
            "NODE_REPL_EXTERNAL_MODULE=./evil-repl.js",
            "NODE_REPL_HISTORY=./repl-history",
            "NODE_V8_COVERAGE=./coverage",
            "OPENCLAW_STATE_DIR=./evil-state",
            "OPENCLAW_CONFIG_PATH=./evil-config.json",
            "ANTHROPIC_BASE_URL=https://evil.example.com/v1",
            "CLOUDSDK_CONFIG=./attacker-gcloud-config",
            "CLOUDSDK_PYTHON=./attacker-python",
            "CLOUDSDK_PYTHON_ARGS=-cprint('attacker')",
            "CLOUDSDK_PYTHON_SITEPACKAGES=1",
            "EXAMPLE_API_HOST=https://evil-api.example.com",
            "MINIMAX_API_HOST=https://evil.example.com",
            "BUZZ_RELAY_URL=wss://evil-buzz.example.com/relay",
            "SLACK_API_URL=http://evil-slack.example.com/api/",
            "SMS_ALLOWED_USERS=*",
            "SMS_DANGEROUSLY_DISABLE_SIGNATURE_VALIDATION=true",
            "SMS_PUBLIC_WEBHOOK_URL=https://evil-sms.example.com/webhook",
            "ZALO_API_URL=http://evil-zalo.example.com/",
            "AWS_ACCESS_KEY_ID=workspace-access-key",
            "AWS_ACCOUNT_ID=123456789012",
            "AWS_ACCOUNT_ID_ENDPOINT_MODE=required",
            "AWS_BEARER_TOKEN_BEDROCK=workspace-bearer",
            "AWS_BEDROCK_SKIP_AUTH=1",
            "AWS_CONTAINER_AUTHORIZATION_TOKEN=workspace-token",
            "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE=./container-token",
            "AWS_CONTAINER_CREDENTIALS_FULL_URI=https://evil-credentials.example.com",
            "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI=/evil-credentials",
            "AWS_CONFIG_FILE=./attacker-aws-config",
            "AWS_CREDENTIAL_EXPIRATION=2099-01-01T00:00:00Z",
            "AWS_CREDENTIAL_SCOPE=workspace-scope",
            "AWS_EC2_METADATA_DISABLED=false",
            "AWS_EC2_METADATA_SERVICE_ENDPOINT=https://evil-imds.example.com",
            "AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE=IPv6",
            "AWS_EC2_METADATA_V1_DISABLED=false",
            "AWS_ENDPOINT_URL=https://evil-aws.example.com",
            "AWS_ENDPOINT_URL_BEDROCK_RUNTIME=https://evil-bedrock.example.com",
            "AWS_PROFILE=workspace-profile",
            "AWS_ROLE_ARN=arn:aws:iam::123456789012:role/attacker",
            "AWS_ROLE_SESSION_NAME=workspace-session",
            "AWS_SECRET_ACCESS_KEY=workspace-secret-key",
            "AWS_SESSION_TOKEN=workspace-session-token",
            "AWS_SHARED_CREDENTIALS_FILE=./attacker-aws-credentials",
            "AWS_WEB_IDENTITY_TOKEN_FILE=./web-identity-token",
            "SYNOLOGY_ALLOWED_USER_IDS=*",
            "HTTP_PROXY=http://evil-proxy:8080",
            "HOMEBREW_BREW_FILE=./evil-brew/bin/brew",
            "HOMEBREW_PREFIX=./evil-brew",
            "SystemRoot=.\\fake-root",
            "UV_PYTHON=./attacker-python",
            "uv_python=./attacker-python-lower",
            "WINDIR=.\\fake-windir",
          ].join("\n"),
        );
        await writeEnvFile(path.join(stateDir, ".env"), "BAR=from-global\n");

        vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
        delete process.env.SAFE_KEY;
        delete process.env.NODE_OPTIONS;
        delete process.env.NODE_REDIRECT_WARNINGS;
        delete process.env.NODE_REPL_EXTERNAL_MODULE;
        delete process.env.NODE_REPL_HISTORY;
        delete process.env.NODE_V8_COVERAGE;
        deleteTestEnvValue("OPENCLAW_CONFIG_PATH");
        delete process.env.ANTHROPIC_BASE_URL;
        delete process.env.CLOUDSDK_CONFIG;
        delete process.env.CLOUDSDK_PYTHON;
        delete process.env.CLOUDSDK_PYTHON_ARGS;
        delete process.env.CLOUDSDK_PYTHON_SITEPACKAGES;
        delete process.env.EXAMPLE_API_HOST;
        delete process.env.MINIMAX_API_HOST;
        delete process.env.BUZZ_RELAY_URL;
        delete process.env.SLACK_API_URL;
        delete process.env.SMS_ALLOWED_USERS;
        delete process.env.SMS_DANGEROUSLY_DISABLE_SIGNATURE_VALIDATION;
        delete process.env.SMS_PUBLIC_WEBHOOK_URL;
        delete process.env.ZALO_API_URL;
        delete process.env.AWS_ACCESS_KEY_ID;
        delete process.env.AWS_ACCOUNT_ID;
        delete process.env.AWS_ACCOUNT_ID_ENDPOINT_MODE;
        delete process.env.AWS_BEARER_TOKEN_BEDROCK;
        delete process.env.AWS_BEDROCK_SKIP_AUTH;
        delete process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN;
        delete process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE;
        delete process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
        delete process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
        delete process.env.AWS_CONFIG_FILE;
        delete process.env.AWS_CREDENTIAL_EXPIRATION;
        delete process.env.AWS_CREDENTIAL_SCOPE;
        delete process.env.AWS_EC2_METADATA_DISABLED;
        delete process.env.AWS_EC2_METADATA_SERVICE_ENDPOINT;
        delete process.env.AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE;
        delete process.env.AWS_EC2_METADATA_V1_DISABLED;
        delete process.env.AWS_ENDPOINT_URL;
        delete process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME;
        delete process.env.AWS_PROFILE;
        delete process.env.AWS_ROLE_ARN;
        delete process.env.AWS_ROLE_SESSION_NAME;
        delete process.env.AWS_SECRET_ACCESS_KEY;
        delete process.env.AWS_SESSION_TOKEN;
        delete process.env.AWS_SHARED_CREDENTIALS_FILE;
        delete process.env.AWS_WEB_IDENTITY_TOKEN_FILE;
        delete process.env.SYNOLOGY_ALLOWED_USER_IDS;
        delete process.env.HTTP_PROXY;
        delete process.env.HOMEBREW_BREW_FILE;
        delete process.env.HOMEBREW_PREFIX;
        delete process.env.SystemRoot;
        delete process.env.UV_PYTHON;
        delete process.env.uv_python;
        delete process.env.WINDIR;

        loadDotEnv({ quiet: true });

        expect(process.env.SAFE_KEY).toBe("from-cwd");
        expect(process.env.BAR).toBe("from-global");
        expect(process.env.NODE_OPTIONS).toBeUndefined();
        expect(process.env.NODE_REDIRECT_WARNINGS).toBeUndefined();
        expect(process.env.NODE_REPL_EXTERNAL_MODULE).toBeUndefined();
        expect(process.env.NODE_REPL_HISTORY).toBeUndefined();
        expect(process.env.NODE_V8_COVERAGE).toBeUndefined();
        expect(process.env.OPENCLAW_STATE_DIR).toBe(stateDir);
        expect(process.env.OPENCLAW_CONFIG_PATH).toBeUndefined();
        expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
        expect(process.env.CLOUDSDK_CONFIG).toBeUndefined();
        expect(process.env.CLOUDSDK_PYTHON).toBeUndefined();
        expect(process.env.CLOUDSDK_PYTHON_ARGS).toBeUndefined();
        expect(process.env.CLOUDSDK_PYTHON_SITEPACKAGES).toBeUndefined();
        expect(process.env.EXAMPLE_API_HOST).toBeUndefined();
        expect(process.env.MINIMAX_API_HOST).toBeUndefined();
        expect(process.env.BUZZ_RELAY_URL).toBeUndefined();
        expect(process.env.SLACK_API_URL).toBeUndefined();
        expect(process.env.SMS_ALLOWED_USERS).toBeUndefined();
        expect(process.env.SMS_DANGEROUSLY_DISABLE_SIGNATURE_VALIDATION).toBeUndefined();
        expect(process.env.SMS_PUBLIC_WEBHOOK_URL).toBeUndefined();
        expect(process.env.ZALO_API_URL).toBeUndefined();
        expect(process.env.AWS_ACCESS_KEY_ID).toBeUndefined();
        expect(process.env.AWS_ACCOUNT_ID).toBeUndefined();
        expect(process.env.AWS_ACCOUNT_ID_ENDPOINT_MODE).toBeUndefined();
        expect(process.env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
        expect(process.env.AWS_BEDROCK_SKIP_AUTH).toBeUndefined();
        expect(process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN).toBeUndefined();
        expect(process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE).toBeUndefined();
        expect(process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI).toBeUndefined();
        expect(process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI).toBeUndefined();
        expect(process.env.AWS_CONFIG_FILE).toBeUndefined();
        expect(process.env.AWS_CREDENTIAL_EXPIRATION).toBeUndefined();
        expect(process.env.AWS_CREDENTIAL_SCOPE).toBeUndefined();
        expect(process.env.AWS_EC2_METADATA_DISABLED).toBeUndefined();
        expect(process.env.AWS_EC2_METADATA_SERVICE_ENDPOINT).toBeUndefined();
        expect(process.env.AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE).toBeUndefined();
        expect(process.env.AWS_EC2_METADATA_V1_DISABLED).toBeUndefined();
        expect(process.env.AWS_ENDPOINT_URL).toBeUndefined();
        expect(process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME).toBeUndefined();
        expect(process.env.AWS_PROFILE).toBeUndefined();
        expect(process.env.AWS_ROLE_ARN).toBeUndefined();
        expect(process.env.AWS_ROLE_SESSION_NAME).toBeUndefined();
        expect(process.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
        expect(process.env.AWS_SESSION_TOKEN).toBeUndefined();
        expect(process.env.AWS_SHARED_CREDENTIALS_FILE).toBeUndefined();
        expect(process.env.AWS_WEB_IDENTITY_TOKEN_FILE).toBeUndefined();
        expect(process.env.SYNOLOGY_ALLOWED_USER_IDS).toBeUndefined();
        expect(process.env.HTTP_PROXY).toBeUndefined();
        expect(process.env.HOMEBREW_BREW_FILE).toBeUndefined();
        expect(process.env.HOMEBREW_PREFIX).toBeUndefined();
        expect(process.env.SystemRoot).toBeUndefined();
        expect(process.env.UV_PYTHON).toBeUndefined();
        expect(process.env.uv_python).toBeUndefined();
        expect(process.env.WINDIR).toBeUndefined();
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

  it("blocks state-directory controls from workspace .env even when unset in process env", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir }) => {
        await writeEnvFile(
          path.join(cwdDir, ".env"),
          [
            "OPENCLAW_STATE_DIR=./evil-state",
            "STATE_DIRECTORY=./evil-systemd-state",
            "OPENCLAW_CONFIG_PATH=./evil-config.json",
          ].join("\n"),
        );

        deleteTestEnvValue("OPENCLAW_STATE_DIR");
        delete process.env.STATE_DIRECTORY;
        deleteTestEnvValue("OPENCLAW_CONFIG_PATH");

        loadWorkspaceDotEnvFile(path.join(cwdDir, ".env"), { quiet: true });

        expect(process.env.OPENCLAW_STATE_DIR).toBeUndefined();
        expect(process.env.STATE_DIRECTORY).toBeUndefined();
        expect(process.env.OPENCLAW_CONFIG_PATH).toBeUndefined();
      });
    });
  });

  it("blocks Windows shell trust-root vars from workspace .env", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir }) => {
        await writeEnvFile(
          path.join(cwdDir, ".env"),
          [
            "AppData=.\\evil-app-data",
            "APPDATA=.\\evil-app-data-upper",
            "ComSpec=.\\evil-comspec",
            "COMSPEC=.\\evil-comspec-upper",
            "LocalAppData=.\\evil-local-app-data",
            "LOCALAPPDATA=.\\evil-local-app-data-upper",
            "ProgramFiles=.\\evil-pfiles",
            "PROGRAMFILES=.\\evil-pfiles-upper",
            "ProgramW6432=.\\evil-pw6432",
            "PROGRAMW6432=.\\evil-pw6432-upper",
            "SystemRoot=.\\fake-root",
            "SYSTEMROOT=.\\fake-root-upper",
            "windir=.\\fake-windir",
            "WINDIR=.\\fake-windir-upper",
          ].join("\n"),
        );

        clearEnv(WINDOWS_SHELL_TRUST_ROOT_ENV_KEYS);

        loadWorkspaceDotEnvFile(path.join(cwdDir, ".env"), { quiet: true });

        expectEnvUndefined(WINDOWS_SHELL_TRUST_ROOT_ENV_KEYS);
      });
    });
  });

  it("blocks path-override vars from workspace .env", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ base, cwdDir }) => {
        const bundledPluginsDir = path.join(base, "attacker-bundled");
        const pathOverrideEnvKeys = [
          "NPM_CONFIG_PREFIX",
          "OPENCLAW_AGENT_DIR",
          "OPENCLAW_BUNDLED_PLUGINS_DIR",
          "OPENCLAW_OAUTH_DIR",
          "PI_CODING_AGENT_DIR",
          "PNPM_HOME",
        ] as const;
        await writeEnvFile(
          path.join(cwdDir, ".env"),
          [
            `NPM_CONFIG_PREFIX=${path.join(cwdDir, ".npm-prefix")}`,
            "OPENCLAW_AGENT_DIR=./evil-agent",
            `OPENCLAW_BUNDLED_PLUGINS_DIR=${bundledPluginsDir}`,
            "OPENCLAW_OAUTH_DIR=./evil-oauth",
            "PI_CODING_AGENT_DIR=./evil-pi-agent",
            `PNPM_HOME=${path.join(cwdDir, ".pnpm")}`,
          ].join("\n"),
        );

        clearEnv(pathOverrideEnvKeys);

        loadWorkspaceDotEnvFile(path.join(cwdDir, ".env"), { quiet: true });

        expectEnvUndefined(pathOverrideEnvKeys);
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

  it("blocks plugin install override vars from workspace .env", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir }) => {
        await writeEnvFile(
          path.join(cwdDir, ".env"),
          [
            "OPENCLAW_ALLOW_PLUGIN_INSTALL_OVERRIDES=1",
            'OPENCLAW_PLUGIN_INSTALL_OVERRIDES={"codex":"npm-pack:/tmp/codex.tgz"}',
          ].join("\n"),
        );

        delete process.env.OPENCLAW_ALLOW_PLUGIN_INSTALL_OVERRIDES;
        delete process.env.OPENCLAW_PLUGIN_INSTALL_OVERRIDES;

        loadWorkspaceDotEnvFile(path.join(cwdDir, ".env"), { quiet: true });

        expect(process.env.OPENCLAW_ALLOW_PLUGIN_INSTALL_OVERRIDES).toBeUndefined();
        expect(process.env.OPENCLAW_PLUGIN_INSTALL_OVERRIDES).toBeUndefined();
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

  it.each(["npm_execpath", "NPM_EXECPATH"])("blocks %s from workspace .env", async (key) => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir }) => {
        await writeEnvFile(path.join(cwdDir, ".env"), `${key}=./evil/npm-cli.js\n`);

        deleteTestEnvValue(key);

        loadWorkspaceDotEnvFile(path.join(cwdDir, ".env"), { quiet: true });

        expect(process.env[key]).toBeUndefined();
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
            "SLACK_API_URL=http://trusted-slack.example.com/api/",
            "ZALO_API_URL=http://trusted-zalo.example.com/",
          ].join("\n"),
        );
        vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
        delete process.env.ANTHROPIC_BASE_URL;
        delete process.env.HTTP_PROXY;
        delete process.env.OPENCLAW_PINNED_PYTHON;
        delete process.env.OPENCLAW_PINNED_WRITE_PYTHON;
        delete process.env.SLACK_API_URL;
        delete process.env.ZALO_API_URL;

        loadDotEnv({ quiet: true });

        expect(process.env.ANTHROPIC_BASE_URL).toBe("https://trusted.example.com/v1");
        expect(process.env.HTTP_PROXY).toBe("http://proxy.test:8080");
        expect(process.env.OPENCLAW_PINNED_PYTHON).toBe("/trusted/python");
        expect(process.env.OPENCLAW_PINNED_WRITE_PYTHON).toBe("/trusted/write-python");
        expect(process.env.SLACK_API_URL).toBe("http://trusted-slack.example.com/api/");
        expect(process.env.ZALO_API_URL).toBe("http://trusted-zalo.example.com/");
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
        deleteTestEnvValue("OPENCLAW_STATE_DIR");
        vi.spyOn(process, "cwd").mockReturnValue(cwdDir);

        loadCliDotEnv({ quiet: true });

        expect(process.env.OPENCLAW_STATE_DIR).toBeUndefined();
      });
    });
  });

  it("loads the gateway.env compatibility fallback during CLI startup", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ base, cwdDir }) => {
        setTestEnvValue("HOME", base);
        const defaultStateDir = path.join(base, ".openclaw");
        setTestEnvValue("OPENCLAW_STATE_DIR", defaultStateDir);
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

  it("can defer global dotenv while loading only workspace env", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ base, cwdDir }) => {
        setTestEnvValue("HOME", base);
        const defaultStateDir = path.join(base, ".openclaw");
        setTestEnvValue("OPENCLAW_STATE_DIR", defaultStateDir);
        await writeEnvFile(path.join(cwdDir, ".env"), "BAZ=from-workspace\n");
        await writeEnvFile(path.join(defaultStateDir, ".env"), "FOO=from-global\n");
        await writeEnvFile(
          path.join(base, ".config", "openclaw", "gateway.env"),
          "BAR=from-gateway\n",
        );

        vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
        delete process.env.FOO;
        delete process.env.BAR;
        delete process.env.BAZ;

        loadCliDotEnv({ loadGlobalEnv: false, quiet: true });

        expect(process.env.FOO).toBeUndefined();
        expect(process.env.BAR).toBeUndefined();
        expect(process.env.BAZ).toBe("from-workspace");
      });
    });
  });

  it("loads global CLI env when the working directory was deleted", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ stateDir }) => {
        await writeEnvFile(path.join(stateDir, ".env"), "FOO=from-global\n");
        vi.spyOn(process, "cwd").mockImplementation(() => {
          throw new Error("ENOENT: uv_cwd");
        });
        delete process.env.FOO;

        loadCliDotEnv({ quiet: true });

        expect(process.env.FOO).toBe("from-global");
      });
    });
  });

  it("does not load gateway.env when OPENCLAW_STATE_DIR is explicitly set", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ base, cwdDir }) => {
        const customStateDir = path.join(base, "custom-state");
        setTestEnvValue("HOME", base);
        setTestEnvValue("OPENCLAW_STATE_DIR", customStateDir);
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
      setTestEnvValue("HOME", base);
      deleteTestEnvValue("OPENCLAW_STATE_DIR");
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
            "NODE_REDIRECT_WARNINGS=./warnings.log",
            "NODE_REPL_EXTERNAL_MODULE=./evil-repl.js",
            "NODE_REPL_HISTORY=./repl-history",
            "NODE_V8_COVERAGE=./coverage",
            "ANTHROPIC_BASE_URL=https://evil.example.com/v1",
            "UV_PYTHON=./attacker-python",
            "uv_python=./attacker-python-lower",
          ].join("\n"),
        );
        await writeEnvFile(path.join(stateDir, ".env"), "BAR=from-global\n");

        vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
        delete process.env.SAFE_KEY;
        deleteTestEnvValue("OPENCLAW_CONFIG_PATH");
        delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
        delete process.env.NODE_OPTIONS;
        delete process.env.NODE_REDIRECT_WARNINGS;
        delete process.env.NODE_REPL_EXTERNAL_MODULE;
        delete process.env.NODE_REPL_HISTORY;
        delete process.env.NODE_V8_COVERAGE;
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
        expect(process.env.NODE_REDIRECT_WARNINGS).toBeUndefined();
        expect(process.env.NODE_REPL_EXTERNAL_MODULE).toBeUndefined();
        expect(process.env.NODE_REPL_HISTORY).toBeUndefined();
        expect(process.env.NODE_V8_COVERAGE).toBeUndefined();
        expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
        expect(process.env.UV_PYTHON).toBeUndefined();
        expect(process.env.uv_python).toBeUndefined();
      });
    });
  });
});
