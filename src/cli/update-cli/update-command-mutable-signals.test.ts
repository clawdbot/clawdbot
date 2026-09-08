import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { getUpdateRun, type createUpdateRun } from "../../infra/update-run-ledger.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);
it.skipIf(process.platform === "win32").each([
  { signal: "SIGINT", mode: "fresh" },
  { signal: "SIGTERM", mode: "fresh" },
  { signal: "SIGINT", mode: "inherited" },
  { signal: "SIGINT", mode: "handoff" },
  { signal: "SIGINT", mode: "pending" },
  { signal: "SIGINT", mode: "activating" },
  { signal: "SIGINT", mode: "lost" },
  { signal: "SIGINT", mode: "missing" },
  { signal: "SIGINT", mode: "completed" },
  { signal: "SIGINT", mode: "no-owner" },
] as const)(
  "settles only the local pre-activation diagnostic under its real executor: $signal/$mode",
  async ({ signal, mode }) => {
    const root = dirs.make("update-owned-signal-");
    const script = path.join(root, "signal.mjs");
    fs.writeFileSync(
      script,
      `
    import fs from 'node:fs';
    import { createUpdateRun, finishUpdateRun, getUpdateRun, recordUpdateRunPhase } from ${JSON.stringify(new URL("../../infra/update-run-ledger.ts", import.meta.url).href)};
    import { beginUpdateRecovery } from ${JSON.stringify(new URL("../../infra/update-run-recovery.ts", import.meta.url).href)};
    import { closeOpenClawStateDatabaseForTest } from ${JSON.stringify(new URL("../../state/openclaw-state-db.ts", import.meta.url).href)};
    import { admitUpdateCommandRun, withUpdatePreviewSignals } from ${JSON.stringify(new URL("./update-command-run.ts", import.meta.url).href)};
    import { withUpdateCommandExecutor } from ${JSON.stringify(new URL("./update-command-executor.ts", import.meta.url).href)};
    const root = ${JSON.stringify(root)};
    const mode = ${JSON.stringify(mode)};
    const opts = {};
    if (mode === 'inherited') process.env.OPENCLAW_UPDATE_RUN_ID = createUpdateRun({trigger:'cli'}).runId;
    const run = await admitUpdateCommandRun({opts, root});
    await withUpdatePreviewSignals({...opts, run}, async () => {
      const sibling = createUpdateRun({trigger:'cli'});
      const hold = async () => {
        recordUpdateRunPhase(run.runId, 'validating');
        if (mode === 'handoff') process.env.OPENCLAW_UPDATE_RUN_HANDOFF = '1';
        if (mode === 'activating') recordUpdateRunPhase(run.runId, 'activating');
        if (mode === 'completed') finishUpdateRun(run.runId, {status:'skipped',reason:'already-current'});
        if (mode === 'pending' || mode === 'missing') {
          const from = {root,nodePath:process.execPath,version:'1.0.0',buildId:null};
          beginUpdateRecovery({runId:run.runId,from,to:{...from,version:'2.0.0'}},run.executorFence,{env:run.env});
        }
        const expected = getUpdateRun(run.runId);
        if (mode === 'missing') {
          closeOpenClawStateDatabaseForTest();
          fs.mkdirSync(root + '/state/.openclaw-restore-00000000-0000-4000-8000-000000000001-0');
          fs.renameSync(root + '/state/openclaw.sqlite',root + '/state/.openclaw-restore-00000000-0000-4000-8000-000000000001-0/displaced');
        }
        process.send({runId:run.runId,expected,sibling});
        await new Promise(() => setInterval(() => {},1000));
      };
      if (mode === 'lost') {
        await withUpdateCommandExecutor(run.runId, async (executor) => {run.executorFence = await executor.enter(root);});
        await hold();
      } else if (mode === 'no-owner') {
        await hold();
      } else {
        await withUpdateCommandExecutor(run.runId, async (executor) => {run.executorFence = await executor.enter(root);await hold();});
      }
    });
  `,
    );
    const child = spawn(process.execPath, ["--import", "./scripts/tsx.mjs", script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
        OPENCLAW_SUPERVISOR_MODE: "external",
        OPENCLAW_UPDATE_RUN_ID: undefined,
        OPENCLAW_UPDATE_RUN_HANDOFF: undefined,
        OPENCLAW_UPDATE_POST_CORE: undefined,
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    const closed = once(child, "close");
    try {
      const message = await Promise.race([
        once(child, "message").then(
          ([payload]) =>
            payload as {
              runId: string;
              expected: ReturnType<typeof getUpdateRun>;
              sibling: ReturnType<typeof createUpdateRun>;
            },
        ),
        closed.then(() => {
          throw new Error(`Update process exited before ready: ${stderr}`);
        }),
      ]);
      expect(child.kill(signal)).toBe(true);
      const [code, exitSignal] = await closed;
      expect(code ?? (exitSignal === "SIGINT" ? 130 : 143)).toBe(signal === "SIGINT" ? 130 : 143);
      const options =
        mode === "missing"
          ? {
              path: path.join(
                root,
                "state",
                ".openclaw-restore-00000000-0000-4000-8000-000000000001-0",
                "displaced",
              ),
            }
          : { env: { OPENCLAW_STATE_DIR: root } };
      const actual = getUpdateRun(message.runId, options);
      if (mode === "fresh") {
        expect(actual).toMatchObject({
          status: "failed",
          phase: "finished",
          reason: "interrupted",
        });
        expect(actual?.steps.some((step) => step.status === "in_progress")).toBe(false);
      } else {
        expect(actual).toEqual(message.expected);
      }
      expect(getUpdateRun(message.sibling.runId, options)).toEqual(message.sibling);
      if (mode === "missing") {
        for (const suffix of ["", "-wal", "-shm"]) {
          expect(fs.existsSync(path.join(root, "state", `openclaw.sqlite${suffix}`))).toBe(false);
        }
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await closed;
    }
  },
  60000,
);
