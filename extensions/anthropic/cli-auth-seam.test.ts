import fs from "node:fs/promises";
import path from "node:path";
import { createWindowsCmdShimFixture, withTempDir } from "openclaw/plugin-sdk/test-env";
import { withMockedWindowsPlatform, withRestoredMocks } from "openclaw/plugin-sdk/test-node-mocks";
import * as windowsSpawn from "openclaw/plugin-sdk/windows-spawn";
import { beforeEach, expect, it, vi } from "vitest";

const { runUtf8CommandWithTimeout } = vi.hoisted(() => ({
  runUtf8CommandWithTimeout: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/process-runtime", () => ({ runUtf8CommandWithTimeout }));

const { probeClaudeCliAuthStatus } = await import("./cli-auth-api.js");

beforeEach(() => {
  runUtf8CommandWithTimeout.mockReset();
});

it("asks Claude CLI for its active account and returns only safe display fields", async () => {
  runUtf8CommandWithTimeout.mockResolvedValue({
    code: 0,
    termination: "exit",
    stdout: JSON.stringify({
      loggedIn: true,
      authMethod: "claude.ai",
      email: " account@example.test ",
      orgId: "private-organization",
      accessToken: "synthetic-access-token",
    }),
  });

  expect(await probeClaudeCliAuthStatus({ command: "/test/claude" })).toEqual({
    status: "available",
    authMethod: "claude.ai",
    email: "account@example.test",
  });

  expect(runUtf8CommandWithTimeout).toHaveBeenCalledWith(
    ["/test/claude", "auth", "status", "--json"],
    expect.objectContaining({ timeoutMs: 3_000, killProcessTree: true }),
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
    const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/process-runtime")>(
      "openclaw/plugin-sdk/process-runtime",
    );
    runUtf8CommandWithTimeout.mockImplementation(actual.runUtf8CommandWithTimeout);
    const resolveProgram = windowsSpawn.resolveWindowsSpawnProgram;
    const resolver = vi
      .spyOn(windowsSpawn, "resolveWindowsSpawnProgram")
      .mockImplementation((params) => resolveProgram({ ...params, platform: "win32" }));
    // Resolve the Windows wrapper, then execute its real JS entrypoint on the host platform.
    await withRestoredMocks([resolver], async () => {
      const result = await probeClaudeCliAuthStatus({
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
      });
      expect(result).toEqual({
        status: "available",
        authMethod: "claude.ai",
        email: "windows@example.test",
      });
      expect(runUtf8CommandWithTimeout).toHaveBeenCalledWith(
        [process.execPath, scriptPath, "auth", "status", "--json"],
        expect.any(Object),
      );
    });
  });
});

it("reports unresolved Windows wrappers as unreadable without spawning", async () => {
  await withTempDir("anthropic-cli-auth-", async (dir) => {
    const command = path.join(dir, "claude.cmd");
    await fs.writeFile(command, "@echo off\r\necho unsupported wrapper\r\n");
    runUtf8CommandWithTimeout.mockRejectedValue(new Error("not executable"));

    await withMockedWindowsPlatform(async () => {
      expect(await probeClaudeCliAuthStatus({ command, env: {} })).toEqual({
        status: "unreadable",
      });
      expect(runUtf8CommandWithTimeout).not.toHaveBeenCalled();
    });
  });
});

it.each(["api_key", "api_key_helper", "oauth_token", "third_party", "none", "unknown-method"])(
  "does not attribute an account email to %s authentication",
  async (authMethod) => {
    runUtf8CommandWithTimeout.mockResolvedValue({
      code: 0,
      termination: "exit",
      stdout: JSON.stringify({ loggedIn: true, authMethod, email: "inactive@example.test" }),
    });

    expect(await probeClaudeCliAuthStatus()).toEqual({
      status: "available",
      ...(authMethod === "unknown-method" ? {} : { authMethod }),
    });
  },
);

it.each([null, " ", "account@example.test\nother", "a".repeat(321)])(
  "keeps account availability when its email cannot be displayed: %j",
  async (email) => {
    runUtf8CommandWithTimeout.mockResolvedValue({
      code: 0,
      termination: "exit",
      stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email }),
    });

    expect(await probeClaudeCliAuthStatus()).toEqual({
      status: "available",
      authMethod: "claude.ai",
    });
  },
);

it("does not inspect Claude token storage when the CLI reports logout", async () => {
  runUtf8CommandWithTimeout.mockResolvedValue({ code: 1, termination: "exit", stdout: "" });

  expect(await probeClaudeCliAuthStatus()).toEqual({ status: "missing" });
});

it("keeps the selected native-login root while removing inherited provider credentials", async () => {
  runUtf8CommandWithTimeout.mockResolvedValue({
    code: 0,
    termination: "exit",
    stdout: JSON.stringify({ loggedIn: true }),
  });

  expect(
    await probeClaudeCliAuthStatus({
      command: "/custom/claude",
      env: {
        ANTHROPIC_API_KEY: "synthetic-ignored-api-key",
        CLAUDE_CODE_OAUTH_TOKEN: "synthetic-ignored-token",
        CLAUDE_CONFIG_DIR: "/tmp/selected-claude-account",
      },
    }),
  ).toEqual({ status: "available" });
  expect(runUtf8CommandWithTimeout).toHaveBeenCalledWith(
    ["/custom/claude", "auth", "status", "--json"],
    expect.objectContaining({ baseEnv: { CLAUDE_CONFIG_DIR: "/tmp/selected-claude-account" } }),
  );
});

it("does not turn a cancelled probe into a logged-out account", async () => {
  const controller = new AbortController();
  const reason = new Error("native auth cancelled");
  runUtf8CommandWithTimeout.mockImplementation(async () => {
    controller.abort(reason);
    return { code: null, termination: "signal", stdout: "" };
  });
  await expect(probeClaudeCliAuthStatus({ signal: controller.signal })).rejects.toBe(reason);
});
