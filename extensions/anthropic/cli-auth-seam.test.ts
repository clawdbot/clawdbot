import fs from "node:fs/promises";
import path from "node:path";
import { createWindowsCmdShimFixture, withTempDir } from "openclaw/plugin-sdk/test-env";
import { withMockedWindowsPlatform } from "openclaw/plugin-sdk/test-node-mocks";
import { beforeEach, expect, it, vi } from "vitest";

const { spawnSync } = vi.hoisted(() => ({
  spawnSync: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const { mockNodeChildProcessSpawnSync } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeChildProcessSpawnSync(spawnSync);
});

const { probeClaudeCliAuthStatus } = await import("./cli-auth-api.js");

beforeEach(() => {
  spawnSync.mockReset();
});

it("asks Claude CLI for its active account and returns only safe display fields", () => {
  spawnSync.mockReturnValue({
    status: 0,
    stdout: JSON.stringify({
      loggedIn: true,
      authMethod: "claude.ai",
      email: " account@example.test ",
      orgId: "private-organization",
      accessToken: "synthetic-access-token",
    }),
  });

  expect(probeClaudeCliAuthStatus({ command: "/test/claude" })).toEqual({
    status: "available",
    authMethod: "claude.ai",
    email: "account@example.test",
  });

  expect(spawnSync).toHaveBeenCalledWith(
    "/test/claude",
    ["auth", "status", "--json"],
    expect.objectContaining({ timeout: 3_000 }),
  );
});

it.each(["PATH", "explicit"])("runs a Windows Claude npm shim selected by %s", async (source) => {
  await withTempDir("anthropic-cli-auth-", async (dir) => {
    const home = await fs.realpath(dir);
    const shimPath = path.join(home, "claude.cmd");
    const scriptPath = path.join(home, "node_modules", "@anthropic-ai", "claude-code", "cli.cjs");
    const configDir = path.join(home, "selected account");
    await createWindowsCmdShimFixture({
      shimPath,
      scriptPath,
      shimLine: [
        "GOTO start",
        ":find_dp0",
        "SET dp0=%~dp0",
        "EXIT /b",
        ":start",
        "CALL :find_dp0",
        `"${process.execPath}" "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.cjs" %*`,
      ].join("\r\n"),
    });
    await fs.writeFile(
      scriptPath,
      `
        const assert = require("node:assert/strict");
        assert.deepEqual(process.argv.slice(2), ["auth", "status", "--json"]);
        assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
        assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
        assert.equal(process.env.CLAUDE_CONFIG_DIR, ${JSON.stringify(configDir)});
        process.stdout.write(JSON.stringify({
          loggedIn: true, authMethod: "claude.ai", email: "windows@example.test"
        }));
      `,
    );
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    spawnSync.mockImplementation(actual.spawnSync);

    withMockedWindowsPlatform(() => {
      expect(
        probeClaudeCliAuthStatus({
          ...(source === "explicit" ? { command: shimPath } : {}),
          env: {
            PATH: `${home};${path.dirname(process.execPath)}`,
            PATHEXT: ".CMD;.EXE;.BAT",
            HOME: home,
            USERPROFILE: home,
            ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
            ANTHROPIC_API_KEY: "synthetic-ignored-api-key",
            CLAUDE_CODE_OAUTH_TOKEN: "synthetic-ignored-token",
            CLAUDE_CONFIG_DIR: configDir,
          },
        }),
      ).toEqual({ status: "available", authMethod: "claude.ai", email: "windows@example.test" });
      expect(spawnSync).toHaveBeenCalledWith(
        process.execPath,
        [scriptPath, "auth", "status", "--json"],
        expect.any(Object),
      );
    });
  });
});

it("reports unresolved Windows wrappers as unreadable without spawning", async () => {
  await withTempDir("anthropic-cli-auth-", async (dir) => {
    const command = path.join(dir, "claude.cmd");
    await fs.writeFile(command, "@echo off\r\necho unsupported wrapper\r\n");
    spawnSync.mockReturnValue({ status: null, error: new Error("not executable") });

    withMockedWindowsPlatform(() => {
      expect(probeClaudeCliAuthStatus({ command, env: {} })).toEqual({ status: "unreadable" });
      expect(spawnSync).not.toHaveBeenCalled();
    });
  });
});

it.each(["api_key", "api_key_helper", "oauth_token", "third_party", "none", "unknown-method"])(
  "does not attribute an account email to %s authentication",
  (authMethod) => {
    spawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ loggedIn: true, authMethod, email: "inactive@example.test" }),
    });

    expect(probeClaudeCliAuthStatus()).toEqual({
      status: "available",
      ...(authMethod === "unknown-method" ? {} : { authMethod }),
    });
  },
);

it.each([null, " ", "account@example.test\nother", "a".repeat(321)])(
  "keeps account availability when its email cannot be displayed: %j",
  (email) => {
    spawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email }),
    });

    expect(probeClaudeCliAuthStatus()).toEqual({
      status: "available",
      authMethod: "claude.ai",
    });
  },
);

it("does not inspect Claude token storage when the CLI reports logout", () => {
  spawnSync.mockReturnValue({ status: 1, stdout: "" });

  expect(probeClaudeCliAuthStatus()).toEqual({ status: "missing" });
});

it("keeps the selected native-login root while removing inherited provider credentials", () => {
  spawnSync.mockReturnValue({ status: 0, stdout: JSON.stringify({ loggedIn: true }) });

  expect(
    probeClaudeCliAuthStatus({
      command: "/custom/claude",
      env: {
        ANTHROPIC_API_KEY: "synthetic-ignored-api-key",
        CLAUDE_CODE_OAUTH_TOKEN: "synthetic-ignored-token",
        CLAUDE_CONFIG_DIR: "/tmp/selected-claude-account",
      },
    }),
  ).toEqual({ status: "available" });
  expect(spawnSync).toHaveBeenCalledWith(
    "/custom/claude",
    ["auth", "status", "--json"],
    expect.objectContaining({ env: { CLAUDE_CONFIG_DIR: "/tmp/selected-claude-account" } }),
  );
});
