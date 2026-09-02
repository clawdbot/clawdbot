import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionSqliteGithubIssue } from "./doctor-session-sqlite-github-issue.js";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawnSync: spawnSyncMock };
});

describe("createSessionSqliteGithubIssue", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  it("bounds GitHub CLI issue creation and preserves the fallback URL on timeout", () => {
    const timeoutError = Object.assign(new Error("spawnSync gh ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });
    spawnSyncMock.mockReturnValue({
      error: timeoutError,
      status: null,
      stderr: Buffer.alloc(0),
      stdout: Buffer.alloc(0),
    });

    const result = createSessionSqliteGithubIssue({
      body: "sanitized body",
      title: "Session SQLite migration recovery report",
      url: "https://github.com/openclaw/openclaw/issues/new?title=recovery",
    });

    expect(spawnSyncMock).toHaveBeenCalledWith(
      "gh",
      [
        "issue",
        "create",
        "--repo",
        "openclaw/openclaw",
        "--title",
        "Session SQLite migration recovery report",
        "--body-file",
        "-",
      ],
      {
        encoding: "buffer",
        input: "sanitized body",
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
        timeout: 30_000,
      },
    );
    expect(result).toEqual({
      fallbackUrl: "https://github.com/openclaw/openclaw/issues/new?title=recovery",
      message: "spawnSync gh ETIMEDOUT",
      ok: false,
    });
  });
});
