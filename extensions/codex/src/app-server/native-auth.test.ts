import { beforeEach, describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());
const spawnSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn, spawnSync }));

import { resolveCodexNativeAuth } from "./native-auth.js";

function result(status: string, code = 0) {
  return {
    error: undefined,
    status: code,
    stdout: status,
    stderr: "",
  };
}

describe("resolveCodexNativeAuth", () => {
  beforeEach(() => {
    spawnSync.mockReset();
  });

  it.each([
    ["Logged in using ChatGPT", "oauth"],
    ["Logged in using an API key - ***", "api-key"],
    ["Logged in using personal access token", "token"],
  ])("accepts Codex status %s", (status, mode) => {
    spawnSync.mockReturnValue(result(status));

    expect(resolveCodexNativeAuth()).toEqual({
      apiKey: "codex-app-server",
      source: "Codex CLI native auth",
      mode,
    });
    expect(spawnSync).toHaveBeenCalledWith(
      "codex",
      ["login", "status"],
      expect.objectContaining({ timeout: 3_000 }),
    );
  });

  it("does not treat Codex logout as native auth", () => {
    spawnSync.mockReturnValue(result("Not logged in", 1));

    expect(resolveCodexNativeAuth()).toBeUndefined();
  });
});
