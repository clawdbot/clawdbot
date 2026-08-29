import { fork } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { parse } from "yaml";
import { waitForChildClose } from "../helpers/process-wait.js";

type Step = { name?: string; run?: string; env?: Record<string, string | number> };
type ProcessRecord = { pid: number; role: string; attempt: number };
type Report = {
  code: number | null;
  cancelledDuringCleanup: boolean;
  error?: string;
  boundaries: { name: string; alive: ProcessRecord[]; sentinelAlive: boolean }[];
  readyAttempts: number[];
  cleanupRemaining: ProcessRecord[];
  ownedProcesses: ProcessRecord[];
  commands: { tool: string; cwd: string; args: string[] }[];
  output: string;
};

export const ciCheckoutFixture = fileURLToPath(
  new URL("./fixtures/ci-platform-checkout.mjs", import.meta.url),
);
const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8")) as {
  jobs: Record<string, { steps: Step[] }>;
};

export function readCiCheckoutStep(job: string, name = "Checkout"): Step & { run: string } {
  const step = workflow.jobs[job]?.steps.find((entry) => entry.name === name);
  if (!step?.run) {
    throw new Error(`Missing executable workflow step ${job}/${name}`);
  }
  return { ...step, run: step.run };
}

export function expectCiCheckoutCleanup(report: Report) {
  expect(report.cleanupRemaining, "fixture cleanup left owned processes").toEqual([]);
  expect(report.boundaries.at(-1)?.name).toBe("exit");
  expect(
    report.boundaries.every((entry) => entry.sentinelAlive),
    "unrelated process killed",
  ).toBe(true);
  expect(
    report.boundaries.filter((entry) => entry.alive.length > 0),
    "Git descendants survived BEFORE deletion, reuse, consumption, or exit",
  ).toEqual([]);
}

export async function withCiCheckoutFixture<T>(
  root: string,
  scenario: string,
  inspect: (
    report: Report,
    result: Awaited<ReturnType<typeof waitForChildClose>>,
    stderr: string,
  ) => T,
): Promise<T> {
  const supervisor = fork(ciCheckoutFixture, ["supervise", root, scenario], {
    detached: true,
    execArgv: [],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  supervisor.stderr?.on("data", (data) => (stderr += String(data)));
  const closed = waitForChildClose(supervisor, 50_000);
  try {
    const result = await closed;
    const report = JSON.parse(readFileSync(path.join(root, "report.json"), "utf8")) as Report;
    return await inspect(report, result, stderr);
  } finally {
    // IPC loss triggers fixture cleanup; never remove its root before joining it.
    if (supervisor.connected) {
      supervisor.disconnect();
    }
    await closed;
    rmSync(root, { recursive: true, force: true });
  }
}
