import { describe, expect, it } from "vitest";
import {
  mergeTelegramProofIntoReleaseBody,
  parseArgs,
  parseWorkflowRunIdFromOutput,
  pollRun,
  readPositiveInt,
  run,
  selectNewestDispatchedRunId,
} from "../../scripts/release-beta-smoke.ts";

describe("release-beta-smoke", () => {
  it("rejects runs with both validation lanes skipped", () => {
    expect(() => parseArgs(["--skip-parallels", "--skip-telegram"])).toThrow(
      "--skip-parallels and --skip-telegram cannot be used together",
    );
  });

  it("stops parsing options after the argument terminator", () => {
    expect(
      parseArgs(["--beta", "beta-a", "--", "--skip-parallels", "--skip-telegram"]),
    ).toMatchObject({
      beta: "beta-a",
      skipParallels: false,
      skipTelegram: false,
    });
  });

  it("accepts package-manager argument separators before script options", () => {
    expect(parseArgs(["--", "--beta", "beta-a", "--skip-parallels"])).toMatchObject({
      beta: "beta-a",
      skipParallels: true,
    });
  });

  it("rejects malformed positive integer environment limits", () => {
    expect(readPositiveInt(undefined, 60, "OPENCLAW_RELEASE_BETA_SMOKE_COMMAND_MS")).toBe(60);
    expect(readPositiveInt("", 60, "OPENCLAW_RELEASE_BETA_SMOKE_COMMAND_MS")).toBe(60);
    expect(readPositiveInt("25", 60, "OPENCLAW_RELEASE_BETA_SMOKE_COMMAND_MS")).toBe(25);

    for (const raw of ["1e3", "25ms", "1.5", "0", "-1", String(Number.MAX_SAFE_INTEGER + 1)]) {
      expect(() => readPositiveInt(raw, 60, "OPENCLAW_RELEASE_BETA_SMOKE_COMMAND_MS")).toThrow(
        "OPENCLAW_RELEASE_BETA_SMOKE_COMMAND_MS must be a positive integer",
      );
    }
  });

  it("parses workflow run urls when gh includes them in dispatch output", () => {
    expect(
      parseWorkflowRunIdFromOutput(
        "Dispatched: https://github.com/openclaw/openclaw/actions/runs/1234567890",
      ),
    ).toBe("1234567890");
  });

  it("selects the newest workflow_dispatch run not present before dispatch", () => {
    const beforeIds = new Set(["100", "101"]);

    expect(
      selectNewestDispatchedRunId({
        beforeIds,
        runs: [
          { databaseId: 100, createdAt: "2026-05-04T10:00:00Z" },
          { databaseId: 102, createdAt: "2026-05-04T10:01:00Z" },
          { databaseId: 103, createdAt: "2026-05-04T10:02:00Z" },
        ],
      }),
    ).toBe("103");
  });

  it("selects runs returned by the actions workflow runs API", () => {
    const beforeIds = new Set(["200"]);

    expect(
      selectNewestDispatchedRunId({
        beforeIds,
        runs: [
          { id: 200, created_at: "2026-05-04T10:00:00Z" },
          { id: 201, created_at: "2026-05-04T10:02:00Z" },
          { id: 202, created_at: "2026-05-04T10:01:00Z" },
        ],
      }),
    ).toBe("201");
  });

  it("replaces stale Telegram proof placeholders", () => {
    const body = [
      "## Changes",
      "",
      "### Release verification",
      "",
      "- npm package: https://www.npmjs.com/package/openclaw/v/2026.5.20-beta.1",
      "- npm Telegram beta E2E: not supplied",
      "",
      "### Assets",
      "",
      "- artifact",
      "",
    ].join("\n");

    const merged = mergeTelegramProofIntoReleaseBody(
      body,
      "- npm Telegram beta E2E: https://github.com/openclaw/openclaw/actions/runs/123",
    );

    expect(merged).toContain("actions/runs/123");
    expect(merged).not.toContain("not supplied");
    expect(merged).toContain("### Assets");
  });

  it("inserts Telegram proof before the next release notes subsection", () => {
    const body = [
      "## Changes",
      "",
      "### Release verification",
      "",
      "- npm package: https://www.npmjs.com/package/openclaw/v/2026.5.20-beta.1",
      "",
      "### Assets",
      "",
      "- artifact",
      "",
    ].join("\n");

    const merged = mergeTelegramProofIntoReleaseBody(
      body,
      "- npm Telegram beta E2E: https://github.com/openclaw/openclaw/actions/runs/123",
    );

    expect(merged.indexOf("actions/runs/123")).toBeLessThan(merged.indexOf("### Assets"));
  });

  it("bounds child command hangs", () => {
    expect(() =>
      run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        capture: true,
        timeoutMs: 50,
      }),
    ).toThrow(/timed out after 50ms/u);
  });

  it("uses a non-ignorable timeout signal for trapped children", () => {
    expect(() =>
      run(
        process.execPath,
        ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
        {
          capture: true,
          timeoutMs: 50,
        },
      ),
    ).toThrow(/timed out after 50ms/u);
  });

  it("stops polling Telegram workflow runs after the timeout budget", async () => {
    let now = 0;
    const sleeps: number[] = [];

    await expect(
      pollRun("openclaw/openclaw", "123", {
        now: () => now,
        pollIntervalMs: 400,
        readRun: () => ({
          conclusion: null,
          html_url: "https://github.com/openclaw/openclaw/actions/runs/123",
          status: "queued",
          updated_at: "2026-05-28T12:00:00Z",
        }),
        sleep: async (ms) => {
          sleeps.push(ms);
          now += ms;
        },
        timeoutMs: 1000,
      }),
    ).rejects.toThrow("Telegram workflow 123 did not complete within 1000ms");
    expect(sleeps).toEqual([400, 400, 200]);
  });

  it("returns when the Telegram workflow succeeds", async () => {
    await expect(
      pollRun("openclaw/openclaw", "123", {
        readRun: () => ({
          conclusion: "success",
          html_url: "https://github.com/openclaw/openclaw/actions/runs/123",
          status: "completed",
          updated_at: "2026-05-28T12:00:00Z",
        }),
        sleep: async () => {
          throw new Error("sleep should not run after completion");
        },
      }),
    ).resolves.toBeUndefined();
  });
});
