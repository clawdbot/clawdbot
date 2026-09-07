import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { triageTestRuntimeEntrypoints } from "./triage-runtime.test-support.js";
import { UPDATE_RUN_ID_ENV } from "./update-control-plane-sentinel.js";
import { createTriageBoundary } from "./update-managed-service-triage.test-support.js";
import { createUpdateRun, getUpdateRun } from "./update-run-ledger.js";

afterEach(() => closeOpenClawStateDatabaseForTest());

it.runIf(process.platform !== "win32")(
  "finishes the original update before the native fixer starts without lending its run identity",
  async () => {
    let runId = "";
    let runEnv: NodeJS.ProcessEnv = {};
    const boundary = await createTriageBoundary(
      "update",
      undefined,
      undefined,
      async (root, env) => {
        runEnv = env;
        runId = createUpdateRun({ trigger: "cli" }, { env }).runId;
        env[UPDATE_RUN_ID_ENV] = runId;
        const ledgerUrl = resolveRuntimeWorkerUrl(
          triageTestRuntimeEntrypoints.updateRunLedger,
        ).href;
        const recoveryModulePath = path.join(root, "ledger.mjs");
        await fs.writeFile(recoveryModulePath, `export * from ${JSON.stringify(ledgerUrl)};`);
        const paramsPath = path.join(root, "handoff.json");
        const params = JSON.parse(await fs.readFile(paramsPath, "utf8"));
        await fs.writeFile(
          paramsPath,
          JSON.stringify({ ...params, runId, recoveryModulePath, recoveryTimeoutMs: 5000 }),
        );
        const updaterPath = path.join(root, "updater.cjs");
        await fs.writeFile(
          updaterPath,
          (await fs.readFile(updaterPath, "utf8")).replace(
            "reason:'original failure'",
            `reason:'original failure',mode:'npm',root:${JSON.stringify(root)}`,
          ),
        );
        const candidatePath = path.join(root, "candidate.mjs");
        const candidate = await fs.readFile(candidatePath, "utf8");
        await fs.writeFile(
          candidatePath,
          `import { getUpdateRun } from ${JSON.stringify(ledgerUrl)};\n` +
            candidate.replace(
              "event('fixer',",
              `event('ledger-before-fixer',{result:getUpdateRun(${JSON.stringify(runId)}),inheritedRunId:process.env[${JSON.stringify(UPDATE_RUN_ID_ENV)}]??null});\nevent('fixer',`,
            ),
        );
      },
    );
    try {
      expect(await boundary.response()).toBe("OPENCLAW_UPDATE_HANDOFF_READY");
      expect(await boundary.control("park")).toBe("parked");
      expect(await boundary.control("commit")).toBe("committed");
      boundary.parent.kill();
      await vi.waitFor(
        async () => {
          expect(
            (await boundary.readEvents()).find((event) => event.kind === "ledger-before-fixer"),
            await boundary.log(),
          ).toMatchObject({
            result: {
              runId,
              status: "failed",
              phase: "finished",
              reason: "managed-service-handoff-failed",
            },
            inheritedRunId: null,
          });
        },
        { timeout: 15_000 },
      );
      expect(await boundary.log()).toContain('"reason":"original failure"');
      const terminal = getUpdateRun(runId, { env: runEnv });
      await boundary.native("stop");
      await boundary.exit;
      expect(getUpdateRun(runId, { env: runEnv })).toEqual(terminal);
    } finally {
      await boundary.cleanup();
    }
  },
);
