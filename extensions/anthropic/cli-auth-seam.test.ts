import { beforeEach, expect, it, vi } from "vitest";

const { spawnSync } = vi.hoisted(() => ({
  spawnSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawnSync }));

const { probeClaudeCliAuthStatus } = await import("./cli-auth-seam.js");

beforeEach(() => {
  spawnSync.mockReset();
});

it("asks Claude CLI to verify its own login", () => {
  spawnSync.mockReturnValue({
    status: 0,
    stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }),
  });

  expect(probeClaudeCliAuthStatus()).toEqual({ status: "available" });

  expect(spawnSync).toHaveBeenCalledWith(
    "claude",
    ["auth", "status", "--json"],
    expect.objectContaining({ timeout: 3_000 }),
  );
});

it("does not inspect Claude token storage when the CLI reports logout", () => {
  spawnSync.mockReturnValue({ status: 1, stdout: "" });

  expect(probeClaudeCliAuthStatus()).toEqual({ status: "missing" });
});
