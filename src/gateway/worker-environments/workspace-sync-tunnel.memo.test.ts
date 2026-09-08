import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  localWorkspaceRunner,
  memoryWorkspaceJournal,
  startConnectedTunnel,
} from "./tunnel.test-support.js";

describe("worker tunnel manager hash memo", () => {
  it("persists the workspace hash memo across reconciliations for one placement", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-worker-memo-persist-"));
    const localPath = path.join(root, "local");
    const remoteHome = path.join(root, "remote-home");
    await Promise.all([
      fs.mkdir(localPath, { recursive: true }),
      fs.mkdir(remoteHome, { recursive: true }),
    ]);
    await fs.writeFile(path.join(localPath, "artifact.txt"), "cross-turn content\n");
    // Manifest captures end with the literal memo-v1 argument; the resolve and
    // setup commands only carry it inside the embedded script source.
    const isMemoCapture = (argv: readonly string[]) =>
      argv[0] === "ssh" && (argv.at(-1)?.endsWith("'memo-v1'") ?? false);
    const captureEnvelopes: Array<{
      metrics: { contentHashCount: number; memoHitCount: number };
    }> = [];
    const fake = localWorkspaceRunner(remoteHome, undefined, (argv, result) => {
      if (isMemoCapture(argv)) {
        captureEnvelopes.push(JSON.parse(result.stdout));
      }
    });
    const { handle } = await startConnectedTunnel(fake, "worker:memo-persist", 3);

    try {
      const synced = await handle.syncWorkspace({
        source: { kind: "local", path: localPath },
        sessionId: "session:memo-persist",
        generation: 1,
      });
      expect(synced.mode).toBe("plain");
      let acceptedManifestRef = synced.manifestRef;
      const journal = memoryWorkspaceJournal((manifestRef) => {
        acceptedManifestRef = manifestRef;
      });
      const memoInputs = () =>
        fake.runs
          .filter((entry) => isMemoCapture(entry.argv))
          .map((entry) => JSON.parse(entry.options.input as string) as [string, string][]);

      const first = await handle.reconcileWorkspace({
        source: { kind: "local", path: localPath, journal },
        remoteWorkspaceDir: synced.remoteWorkspaceDir,
        baseManifestRef: synced.manifestRef,
      });
      expect(first.changed).toBe(false);
      const firstTurnCaptures = memoInputs().length;
      // The placement's first reconciliation necessarily starts empty.
      expect(memoInputs()[0]).toEqual([]);

      const second = await handle.reconcileWorkspace({
        source: { kind: "local", path: localPath, journal },
        remoteWorkspaceDir: synced.remoteWorkspaceDir,
        baseManifestRef: acceptedManifestRef,
      });
      expect(second.changed).toBe(false);
      // The second turn's first capture must reuse the prior turn's worker
      // entries; a per-call memo would send an empty payload again.
      const secondTurnFirstInput = memoInputs()[firstTurnCaptures]!;
      expect(secondTurnFirstInput.length).toBeGreaterThan(0);
      expect(secondTurnFirstInput.every(([identity]) => identity.startsWith("worker:"))).toBe(true);
      const secondTurnFirstEnvelope = captureEnvelopes[firstTurnCaptures]!;
      expect(secondTurnFirstEnvelope.metrics.contentHashCount).toBe(0);
      expect(secondTurnFirstEnvelope.metrics.memoHitCount).toBeGreaterThan(0);
    } finally {
      await handle.stop();
      await fs.rm(root, { recursive: true });
    }
  }, 60_000);
});
