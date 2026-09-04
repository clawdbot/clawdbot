import {
  execFile as execFileCallback,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { snapshotGatewayStartupEnv } from "../../../../src/gateway/test-helpers.env.js";
import { withEnvAsync } from "../../../../src/test-utils/env.js";
import { waitForFile } from "../../../helpers/process-wait.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { runGatewaySshTunnels } from "./gateway-ssh-tunnels.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const describeOnTestbox = process.env.OPENCLAW_TESTBOX === "1" ? describe : describe.skip;
const activeChildren = new Set<ChildProcessWithoutNullStreams>();
const producerPath = path.resolve(process.cwd(), "test/e2e/qa-lab/runtime/gateway-ssh-tunnels.ts");
const accountKnownHostsPath = path.join(os.userInfo().homedir, ".ssh", "known_hosts");
const producerReadyMarker = "OPENCLAW_QA_PRODUCER_READY";
const execFile = promisify(execFileCallback);
const producerChildSource = `
import { pathToFileURL } from "node:url";
const producerPath = process.env.OPENCLAW_QA_PRODUCER_PATH;
const artifactBase = process.env.OPENCLAW_QA_ARTIFACT_BASE;
const fixtureReadyPath = process.env.OPENCLAW_QA_FIXTURE_READY_PATH;
const fixtureProcessPath = process.env.OPENCLAW_QA_FIXTURE_PROCESS_PATH;
const fixtureRoot = process.env.OPENCLAW_QA_FIXTURE_ROOT;
if (!producerPath || !artifactBase) {
  throw new Error("missing producer child paths");
}
const { runGatewaySshTunnels } = await import(pathToFileURL(producerPath).href);
const startSignal = new Promise((resolve) => process.stdin.once("data", resolve));
process.stdout.write("${producerReadyMarker}\\n");
await startSignal;
const evidence = await runGatewaySshTunnels({
  artifactBase,
  fixtureProcessPath,
  fixtureReadyPath,
  fixtureRoot,
  repoRoot: process.cwd(),
});
process.exitCode = evidence.entries[0]?.result.status === "pass" ? 0 : 1;
`;

describe("Gateway SSH tunnel QA preflight", () => {
  it("records blocked evidence outside Testbox without privileged setup", async () => {
    const artifactBase = tempDirs.make("openclaw-gateway-ssh-guard-");
    const evidence = await withEnvAsync({ OPENCLAW_TESTBOX: undefined }, async () =>
      runGatewaySshTunnels({ artifactBase, repoRoot: process.cwd() }),
    );

    expect(evidence.entries[0]?.result).toMatchObject({ status: "blocked" });
    await expect(fs.access(path.join(artifactBase, ".ssh-namespace"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

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

function startProducer(
  artifactBase: string,
  fixture?: { processPath: string; readyPath: string; root: string },
) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", producerChildSource],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENCLAW_QA_ARTIFACT_BASE: artifactBase,
        OPENCLAW_QA_FIXTURE_PROCESS_PATH: fixture?.processPath,
        OPENCLAW_QA_FIXTURE_READY_PATH: fixture?.readyPath,
        OPENCLAW_QA_FIXTURE_ROOT: fixture?.root,
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
    kill: () => terminateChild(child),
    ready,
    start: () => child.stdin.end("start\n"),
  };
}

async function killPrivilegedProcessGroup(pid: number) {
  if (typeof process.getuid !== "function" || process.getuid() === 0) {
    await execFile("/bin/kill", ["-KILL", "--", `-${pid}`]);
    return;
  }
  await execFile("/usr/bin/sudo", ["-n", "--", "/bin/kill", "-KILL", "--", `-${pid}`]);
}

async function readSummary(artifactBase: string) {
  return JSON.parse(
    await fs.readFile(path.join(artifactBase, "gateway-ssh-tunnels-summary.json"), "utf8"),
  ) as {
    cleanupReleased?: boolean;
    knownHostsIsolated?: boolean;
  };
}

async function readOptionalFile(filePath: string) {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

describeOnTestbox("Gateway SSH tunnel QA producer", () => {
  it("proves real forwarding, cleanup, and operator diagnostics", async () => {
    const artifactBase = tempDirs.make("openclaw-gateway-ssh-evidence-");
    const gatewayStartupEnv = snapshotGatewayStartupEnv();
    const evidence = await runGatewaySshTunnels({
      artifactBase,
      repoRoot: process.cwd(),
    });

    expect(snapshotGatewayStartupEnv()).toEqual(gatewayStartupEnv);
    expect(evidence.entries).toHaveLength(1);
    expect(evidence.entries[0]?.result.status).toBe("pass");
    const summary = JSON.parse(
      await fs.readFile(path.join(artifactBase, "gateway-ssh-tunnels-summary.json"), "utf8"),
    ) as {
      cleanupReleased?: boolean;
      hostKeyDiagnostic?: string;
      knownHostsIsolated?: boolean;
      unreachableDiagnostic?: string;
    };
    expect(summary.cleanupReleased).toBe(true);
    expect(summary.knownHostsIsolated).toBe(true);
    expect(summary.hostKeyDiagnostic).toMatch(
      /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i,
    );
    expect(summary.unreachableDiagnostic).toMatch(/Connection refused|connect to host|ssh exited/i);
  }, 120_000);

  it("keeps overlapping and killed producers isolated from account SSH state", async () => {
    const accountKnownHostsBefore = await readOptionalFile(accountKnownHostsPath);
    const firstArtifactBase = tempDirs.make("openclaw-gateway-ssh-overlap-first-");
    const secondArtifactBase = tempDirs.make("openclaw-gateway-ssh-overlap-second-");
    const first = startProducer(firstArtifactBase);
    const second = startProducer(secondArtifactBase);
    await Promise.all([first.ready, second.ready]);
    first.start();
    second.start();

    await Promise.all([first.completion, second.completion]);
    const summaries = await Promise.all([
      readSummary(firstArtifactBase),
      readSummary(secondArtifactBase),
    ]);
    expect(summaries.every((summary) => summary.cleanupReleased === true)).toBe(true);
    expect(summaries.every((summary) => summary.knownHostsIsolated === true)).toBe(true);
    expect(await readOptionalFile(accountKnownHostsPath)).toEqual(accountKnownHostsBefore);

    const killedArtifactBase = tempDirs.make("openclaw-gateway-ssh-killed-");
    const killedRoot = tempDirs.make("openclaw-gateway-ssh-killed-root-");
    const fixtureReadyPath = path.join(killedArtifactBase, "trust-prepared");
    const fixtureProcessPath = path.join(killedArtifactBase, "namespace-pid");
    const killed = startProducer(killedArtifactBase, {
      processPath: fixtureProcessPath,
      readyPath: fixtureReadyPath,
      root: killedRoot,
    });
    await killed.ready;
    killed.start();
    await waitForFile(fixtureReadyPath, 10_000);
    const namespacePid = Number.parseInt(await fs.readFile(fixtureProcessPath, "utf8"), 10);
    expect(namespacePid).toBeGreaterThan(1);
    await killPrivilegedProcessGroup(namespacePid);
    await expect(killed.completion).rejects.toThrow(
      /namespaced Gateway SSH tunnel producer exited/,
    );
    expect(await readOptionalFile(accountKnownHostsPath)).toEqual(accountKnownHostsBefore);
  }, 180_000);
});
