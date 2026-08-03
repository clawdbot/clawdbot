import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { runGatewaySshTunnels } from "./gateway-ssh-tunnels.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const describeOnTestbox = process.env.OPENCLAW_TESTBOX === "1" ? describe : describe.skip;

describeOnTestbox("Gateway SSH tunnel QA producer", () => {
  it("proves real forwarding, cleanup, and operator diagnostics", async () => {
    const artifactBase = tempDirs.make("openclaw-gateway-ssh-evidence-");
    const evidence = await runGatewaySshTunnels({
      artifactBase,
      repoRoot: process.cwd(),
    });

    expect(evidence.entries).toHaveLength(1);
    expect(evidence.entries[0]?.result.status).toBe("pass");
    const summary = JSON.parse(
      await fs.readFile(path.join(artifactBase, "gateway-ssh-tunnels-summary.json"), "utf8"),
    ) as {
      cleanupReleased?: boolean;
      hostKeyDiagnostic?: string;
      unreachableDiagnostic?: string;
    };
    expect(summary.cleanupReleased).toBe(true);
    expect(summary.hostKeyDiagnostic).toMatch(
      /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i,
    );
    expect(summary.unreachableDiagnostic).toMatch(/Connection refused|connect to host|ssh exited/i);
  }, 120_000);
});
