import { beforeEach, expect, it, vi } from "vitest";

const { spawnSync } = vi.hoisted(() => ({
  spawnSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawnSync }));

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

  expect(probeClaudeCliAuthStatus()).toEqual({
    status: "available",
    authMethod: "claude.ai",
    email: "account@example.test",
  });

  expect(spawnSync).toHaveBeenCalledWith(
    "claude",
    ["auth", "status", "--json"],
    expect.objectContaining({ timeout: 3_000 }),
  );
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
