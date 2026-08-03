import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { waitForFile } from "../../../helpers/process-wait.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { runGatewaySshTunnels } from "./gateway-ssh-tunnels.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const describeOnTestbox = process.env.OPENCLAW_TESTBOX === "1" ? describe : describe.skip;
const activeChildren = new Set<ChildProcessWithoutNullStreams>();
const producerPath = path.resolve(process.cwd(), "test/e2e/qa-lab/runtime/gateway-ssh-tunnels.ts");
const knownHostsLockPath = path.join(
  os.userInfo().homedir,
  ".ssh",
  ".openclaw-qa-known-hosts.lock",
);
const producerReadyMarker = "OPENCLAW_QA_PRODUCER_READY";
const producerChildSource = `
import { pathToFileURL } from "node:url";
const producerPath = process.env.OPENCLAW_QA_PRODUCER_PATH;
const artifactBase = process.env.OPENCLAW_QA_ARTIFACT_BASE;
if (!producerPath || !artifactBase) {
  throw new Error("missing producer child paths");
}
const { runGatewaySshTunnels } = await import(pathToFileURL(producerPath).href);
const startSignal = new Promise((resolve) => process.stdin.once("data", resolve));
process.stdout.write("${producerReadyMarker}\\n");
await startSignal;
const evidence = await runGatewaySshTunnels({ artifactBase, repoRoot: process.cwd() });
process.exitCode = evidence.entries[0]?.result.status === "pass" ? 0 : 1;
`;

async function terminateChild(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGKILL");
  await once(child, "close");
}

afterEach(async () => {
  await Promise.all(Array.from(activeChildren, terminateChild));
  activeChildren.clear();
});

function startProducer(artifactBase: string) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", producerChildSource],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENCLAW_QA_ARTIFACT_BASE: artifactBase,
        OPENCLAW_QA_PRODUCER_PATH: producerPath,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  activeChildren.add(child);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  let resolveReady: () => void;
  let rejectReady: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
    if (stdout.includes(producerReadyMarker)) {
      resolveReady();
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const completion = new Promise<void>((resolve, reject) => {
    child.once("error", (error) => {
      rejectReady(error);
      reject(error);
    });
    child.once("close", (code, signal) => {
      activeChildren.delete(child);
      if (code === 0) {
        resolve();
        return;
      }
      const error = new Error(
        `Gateway SSH tunnel producer exited ${code ?? "null"}/${signal ?? "none"}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      );
      rejectReady(error);
      reject(error);
    });
  });
  void completion.catch(() => {});
  return {
    completion,
    ready,
    start: () => child.stdin.end("start\n"),
  };
}

async function readSummary(artifactBase: string) {
  return JSON.parse(
    await fs.readFile(path.join(artifactBase, "gateway-ssh-tunnels-summary.json"), "utf8"),
  ) as {
    cleanupReleased?: boolean;
    knownHostsLockWaitMs?: number;
  };
}

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

  it("serializes overlapping producers before restoring shared SSH state", async () => {
    const firstArtifactBase = tempDirs.make("openclaw-gateway-ssh-overlap-first-");
    const secondArtifactBase = tempDirs.make("openclaw-gateway-ssh-overlap-second-");
    const first = startProducer(firstArtifactBase);
    const second = startProducer(secondArtifactBase);
    await Promise.all([first.ready, second.ready]);
    first.start();
    await waitForFile(knownHostsLockPath, 10_000);
    second.start();

    await Promise.all([first.completion, second.completion]);
    const summaries = await Promise.all([
      readSummary(firstArtifactBase),
      readSummary(secondArtifactBase),
    ]);
    expect(summaries.every((summary) => summary.cleanupReleased === true)).toBe(true);
    expect(
      Math.max(...summaries.map((summary) => summary.knownHostsLockWaitMs ?? 0)),
    ).toBeGreaterThan(0);
    await expect(fs.access(knownHostsLockPath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 180_000);
});
