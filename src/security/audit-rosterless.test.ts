import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

vi.unmock("../agents/agent-scope-config.js");

const { runSecurityAudit } = await import("./audit.js");

describe("security audit rosterless configs", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("uses the explicit audit workspace without resolving a missing roster default", async () => {
    const rootDir = tempDirs.make("openclaw-audit-rosterless-");
    const stateDir = path.join(rootDir, "state");
    const workspaceDir = path.join(rootDir, "workspace");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });

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
});
