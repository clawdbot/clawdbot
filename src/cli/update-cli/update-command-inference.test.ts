import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runUpdateInferenceProbe } from "./update-command-inference.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const workerPids = new Set<number>();
afterEach(() => {
  for (const pid of workerPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  workerPids.clear();
});
async function candidateWorker(source: string) {
  const root = await fs.realpath(dirs.make("candidate-inference-"));
  const worker = path.join(root, "dist/infra/update-inference-probe.worker.js");
  await fs.mkdir(path.dirname(worker), { recursive: true });
  await fs.writeFile(worker, source);
  return { root, env: { ...process.env, OPENCLAW_STATE_DIR: root } };
}

describe("candidate inference worker", () => {
  it.each([0, 1])(
    "runs the candidate's current worker and treats exit %s as advisory evidence",
    async (code) => {
      const candidate = await candidateWorker(`
      if (process.cwd() !== process.env.OPENCLAW_STATE_DIR || process.env.OPENCLAW_UPDATE_IN_PROGRESS !== '0') process.exit(2);
      process.exit(${code});
    `);
      expect(await runUpdateInferenceProbe({ ...candidate, nodeRunner: process.execPath })).toBe(
        code === 0,
      );
      await fs.rm(path.join(candidate.root, "dist"), { recursive: true });
      expect(await runUpdateInferenceProbe({ ...candidate, nodeRunner: process.execPath })).toBe(
        false,
      );
    },
  );

  it("bounds the whole worker and tears down a stalled probe", async () => {
    const candidate = await candidateWorker(`
      require('node:fs').writeFileSync('probe.pid', String(process.pid));
      const scratch = require('node:os').tmpdir();
      require('node:fs').writeFileSync('probe.scratch', scratch);
      require('node:fs').writeFileSync(require('node:path').join(scratch, 'copied-auth'), 'synthetic');
      setInterval(() => {}, 1000);
    `);
    const probe = runUpdateInferenceProbe({ ...candidate, nodeRunner: process.execPath });
    const pid = await vi.waitFor(
      async () => Number(await fs.readFile(path.join(candidate.root, "probe.pid"), "utf8")),
      { timeout: 5_000 },
    );
    workerPids.add(pid);
    expect(await probe).toBe(false);
    expect(() => process.kill(pid, 0)).toThrow();
    workerPids.delete(pid);
    const scratch = await fs.readFile(path.join(candidate.root, "probe.scratch"), "utf8");
    await expect(fs.access(scratch)).rejects.toMatchObject({ code: "ENOENT" });
  }, 25_000);
});
