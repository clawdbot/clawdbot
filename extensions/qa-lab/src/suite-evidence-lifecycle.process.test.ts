import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

type ChildMessage = {
  code?: string;
  lockPath?: string;
  message?: string;
  result?: string;
  type: "completed" | "entered" | "error" | "result";
};

const fixturePath = fileURLToPath(
  new URL("./suite-evidence-lifecycle.process-fixture.ts", import.meta.url),
);
const tempRoots: string[] = [];
const children = new Set<ChildProcess>();

async function makeOutputDir(label: string) {
  const repoRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), label)));
  const outputDir = path.join(repoRoot, "output");
  tempRoots.push(repoRoot);
  await fs.mkdir(outputDir, { recursive: true });
  return { outputDir, repoRoot };
}

function spawnFixture(outputDir: string, mode: string, markerPath: string) {
  const child = fork(fixturePath, [outputDir, mode, markerPath], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.add(child);
  const messages: ChildMessage[] = [];
  let stderr = "";
  child.on("message", (message) => messages.push(message as ChildMessage));
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.once("exit", () => children.delete(child));
  return {
    child,
    messages,
    waitForMessage: (type: ChildMessage["type"], timeoutMs = 5_000) =>
      new Promise<ChildMessage>((resolve, reject) => {
        const existing = messages.find((message) => message.type === type);
        if (existing) {
          resolve(existing);
          return;
        }
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${type}; stderr=${stderr}`)),
          timeoutMs,
        );
        const onMessage = (message: unknown) => {
          const typed = message as ChildMessage;
          if (typed.type !== type) {
            return;
          }
          clearTimeout(timer);
          child.off("message", onMessage);
          resolve(typed);
        };
        child.on("message", onMessage);
      }),
    waitForExit: (timeoutMs = 5_000) =>
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve({ code: child.exitCode, signal: child.signalCode });
          return;
        }
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for child exit; stderr=${stderr}`)),
          timeoutMs,
        );
        child.once("exit", (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal });
        });
      }),
  };
}

afterEach(async () => {
  for (const child of children) {
    child.kill("SIGKILL");
  }
  children.clear();
  await Promise.all(
    tempRoots.splice(0).map((repoRoot) => fs.rm(repoRoot, { recursive: true, force: true })),
  );
});

describe("QA suite evidence lifecycle process locking", () => {
  it("fails a same-output loser before callback entry and preserves winner artifacts", async () => {
    const { outputDir } = await makeOutputDir("qa-evidence-process-contention-");
    const canonicalPath = path.join(outputDir, "qa-evidence.json");
    const lockPath = `${outputDir}.lock`;
    const winnerMarker = path.join(outputDir, "winner.marker");
    const loserMarker = path.join(outputDir, "loser.marker");
    const winner = spawnFixture(outputDir, "hold", winnerMarker);
    await winner.waitForMessage("entered");
    await expect(fs.access(lockPath)).resolves.toBeUndefined();

    const loser = spawnFixture(outputDir, "loser", loserMarker);
    const loserError = await loser.waitForMessage("error");
    expect(loserError.code).toBe("file_lock_timeout");
    expect(loserError.lockPath).toBe(lockPath);
    expect(loser.messages.some((message) => message.type === "entered")).toBe(false);
    await expect(fs.access(canonicalPath)).rejects.toMatchObject({ code: "ENOENT" });
    await loser.waitForExit();

    winner.child.send("release");
    await winner.waitForMessage("completed");
    await winner.waitForExit();
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await fs.readFile(canonicalPath, "utf8"))).toMatchObject({ profile: "hold" });
    await expect(fs.readFile(winnerMarker, "utf8")).resolves.toBe("hold\n");
    await expect(fs.access(loserMarker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers a dead owner after SIGKILL without reviving stale canonical evidence", async () => {
    const { outputDir } = await makeOutputDir("qa-evidence-process-recovery-");
    const canonicalPath = path.join(outputDir, "qa-evidence.json");
    await fs.writeFile(canonicalPath, "stale\n", "utf8");
    const crashed = spawnFixture(outputDir, "crash", path.join(outputDir, "crash.marker"));
    await crashed.waitForMessage("entered");
    await expect(fs.access(canonicalPath)).rejects.toMatchObject({ code: "ENOENT" });

    crashed.child.kill("SIGKILL");
    await expect(crashed.waitForExit()).resolves.toMatchObject({ signal: "SIGKILL" });

    const recoveryMarker = path.join(outputDir, "recovery.marker");
    const recovery = spawnFixture(outputDir, "recovery", recoveryMarker);
    await recovery.waitForMessage("entered");
    await recovery.waitForMessage("completed");
    await recovery.waitForExit();

    expect(JSON.parse(await fs.readFile(canonicalPath, "utf8"))).toMatchObject({
      profile: "recovery",
    });
    await expect(fs.readFile(recoveryMarker, "utf8")).resolves.toBe("recovery\n");
  });
});
