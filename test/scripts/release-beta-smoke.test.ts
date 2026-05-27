import { describe, expect, it } from "vitest";
import {
  mergeTelegramProofIntoReleaseBody,
  parseArgs,
  parseWorkflowRunIdFromOutput,
  selectNewestDispatchedRunId,
} from "../../scripts/release-beta-smoke.ts";

describe("release-beta-smoke", () => {
  it("rejects runs with both validation lanes skipped", () => {
    expect(() => parseArgs(["--skip-parallels", "--skip-telegram"])).toThrow(
      "--skip-parallels and --skip-telegram cannot be used together",
    );
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
});
