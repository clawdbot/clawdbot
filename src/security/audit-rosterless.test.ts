import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

vi.unmock("../agents/agent-scope-config.js");

const { runSecurityAudit } = await import("./audit.js");

describe("security audit rosterless configs", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  function makeAuditPaths(label: string) {
    const rootDir = tempDirs.make(`openclaw-audit-${label}-`);
    const stateDir = path.join(rootDir, "state");
    const workspaceDir = path.join(rootDir, "workspace");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    return { stateDir, workspaceDir };
  }

  it("uses the explicit audit workspace without resolving a missing roster default", async () => {
    const { stateDir, workspaceDir } = makeAuditPaths("rosterless");

    await expect(
      runSecurityAudit({
        config: {},
        stateDir,
        configPath: path.join(stateDir, "openclaw.json"),
        workspaceDir,
        env: {},
        includeFilesystem: true,
        includeChannelSecurity: false,
      }),
    ).resolves.toEqual(expect.objectContaining({ findings: expect.any(Array) }));
  });

  it.each([
    {
      label: "an explicitly empty roster",
      entries: {},
      expectedCount: 0,
    },
    {
      label: "no default",
      entries: { main: {}, ops: {} },
      expectedCount: 0,
    },
    {
      label: "multiple defaults",
      entries: { main: { default: true }, ops: { default: true } },
      expectedCount: 2,
    },
  ])(
    "reports a malformed roster with $label without aborting",
    async ({ entries, expectedCount }) => {
      const { stateDir, workspaceDir } = makeAuditPaths("malformed-roster");

      const report = await runSecurityAudit({
        config: { agents: { entries } } as never,
        stateDir,
        configPath: path.join(stateDir, "openclaw.json"),
        workspaceDir,
        env: {},
        includeFilesystem: true,
        includeChannelSecurity: false,
      });

      expect(report.findings).toContainEqual(
        expect.objectContaining({
          checkId: "config.agent_roster.invalid_default_count",
          detail: expect.stringContaining(`found ${expectedCount}`),
        }),
      );
    },
  );
});
