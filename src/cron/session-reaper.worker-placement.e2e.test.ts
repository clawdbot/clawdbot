import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { resolveDefaultSessionStorePath } from "../config/sessions/paths.js";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.runtime.js";
import {
  createGatewayConfigPath,
  removeGatewayTempHome,
  resetGatewayTestState,
  setupGatewayTempHome,
} from "../gateway/gateway.test-support.js";
import { startGatewayServer } from "../gateway/server.js";
import type { SessionsListResult } from "../gateway/session-utils.types.js";
import { getGatewayE2ePortBlock } from "../gateway/test-helpers.e2e.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import type { CronRunLogEntry } from "./run-log-types.js";
import type { CronJob } from "./types.js";

const backendSource = `
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const control = process.argv[2];
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const id = /fixture-case:([a-z-]+)/.exec(prompt)?.[1];
if (!id) throw new Error("Missing fixture case in CLI input");
const mark = (event) => fs.writeFileSync(path.join(control, id + "." + event), "");
process.on("SIGTERM", () => mark("cancelled"));
process.on("SIGINT", () => mark("cancelled"));
mark("started");
const deadline = Date.now() + 60000;
while (!fs.existsSync(path.join(control, id + ".release"))) {
  if (Date.now() >= deadline) throw new Error("CLI fixture release deadline exceeded");
  await delay(25);
}
mark("released");
process.stdout.write("Completed synthetic cron fixture.\\n");
`;

describe("scheduled cron session retirement through the Gateway", () => {
  let setup: Awaited<ReturnType<typeof setupGatewayTempHome>> | undefined;
  let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
  let control: string;
  let stateDatabasePath: string;
  let sessionStorePath: string;

  const call = <T>(method: string, params?: unknown) =>
    callGateway<T>({ method, params, timeoutMs: 15_000 });
  const entry = (sessionKey: string) =>
    loadExactSessionEntry({ storePath: sessionStorePath, sessionKey })?.entry;
  const placement = (sessionId: string) => {
    const database = new DatabaseSync(stateDatabasePath, { readOnly: true });
    try {
      return database
        .prepare(
          "SELECT session_key, state, turn_claim_id FROM worker_session_placements WHERE session_id = ?",
        )
        .get(sessionId);
    } finally {
      database.close();
    }
  };
  const history = (id: string) => call<{ entries: CronRunLogEntry[] }>("cron.runs", { id });

  beforeAll(async () => {
    resetGatewayTestState();
    setup = await setupGatewayTempHome({ prefix: "openclaw-scheduled-cron-retirement-" });
    deleteTestEnvValue("OPENCLAW_SKIP_CRON");
    deleteTestEnvValue("OPENCLAW_SKIP_PROVIDERS");
    control = path.join(setup.tempHome, "control");
    const plugin = path.join(setup.tempHome, "cron-fixture-plugin");
    await fs.mkdir(control);
    await fs.mkdir(plugin);
    const backend = path.join(plugin, "backend.mjs");
    await fs.writeFile(backend, backendSource);
    await fs.writeFile(
      path.join(plugin, "package.json"),
      JSON.stringify({
        name: "openclaw-cron-retirement-fixture",
        version: "1.0.0",
        type: "module",
        openclaw: { extensions: ["./index.mjs"] },
      }),
    );
    await fs.writeFile(
      path.join(plugin, "openclaw.plugin.json"),
      JSON.stringify({
        id: "cron-fixture-cli",
        name: "Cron retirement fixture",
        cliBackends: ["cron-fixture-cli"],
        activation: { onStartup: true },
        configSchema: { type: "object", properties: {}, additionalProperties: false },
      }),
    );
    // Exercise the documented CLI backend plugin contract with a real child process.
    await fs.writeFile(
      path.join(plugin, "index.mjs"),
      `export default {
        id: "cron-fixture-cli",
        name: "Cron retirement fixture",
        register(api) {
          api.registerCliBackend({ id: "cron-fixture-cli", config: {
            command: ${JSON.stringify(process.execPath)},
            args: ${JSON.stringify([backend, control])},
            output: "text", input: "stdin", sessionMode: "none", serialize: false,
          }});
        },
      };`,
    );
    const port = await getGatewayE2ePortBlock();
    const token = "synthetic-cron-retirement-token";
    const configPath = await createGatewayConfigPath(setup.tempHome);
    const config: OpenClawConfig = {
      gateway: {
        mode: "local",
        port,
        bind: "loopback",
        auth: { mode: "token", token },
        controlUi: { enabled: false },
      },
      agents: {
        defaults: {
          workspace: setup.workspaceDir,
          model: "cron-fixture-cli/proof",
          timeoutSeconds: 60,
        },
        entries: { main: {} },
      },
      plugins: {
        allow: ["cron-fixture-cli"],
        load: { paths: [plugin] },
        slots: { memory: "none" },
        entries: { "cron-fixture-cli": { enabled: true } },
      },
      cron: { enabled: true },
    };
    await fs.writeFile(configPath, JSON.stringify(config));
    setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
    setTestEnvValue("OPENCLAW_GATEWAY_PORT", String(port));
    setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", token);
    stateDatabasePath = path.join(setup.tempHome, ".openclaw", "state", "openclaw.sqlite");
    sessionStorePath = resolveDefaultSessionStorePath("main");
    server = await startGatewayServer(port, { controlUiEnabled: false });
  }, 120_000);

  afterEach(async () => {
    try {
      if (setup && existsSync(control)) {
        for (const id of ["removed", "one-shot"]) {
          await fs.writeFile(path.join(control, `${id}.release`), "");
        }
      }
      await server?.close({ reason: "scheduled cron retirement tests complete" });
    } finally {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      resetGatewayTestState();
      if (setup) {
        try {
          await removeGatewayTempHome(setup.tempHome);
        } finally {
          setup.envSnapshot.restore();
        }
      }
    }
  }, 120_000);

  it("retires a removed scheduled job and preserves one-shot cleanup on the same Gateway", async () => {
    // Runtime test setup resets plugin registrations after each test, so both flows share this test.
    const retainedRuns = new Map<string, CronRunLogEntry[]>();
    for (const id of ["removed", "one-shot"] as const) {
      const oneShot = id === "one-shot";
      const job = await call<CronJob>("cron.add", {
        name: `Retirement fixture ${id}`,
        agentId: "main",
        schedule: oneShot
          ? { kind: "at", at: new Date(Date.now() + 1_000).toISOString() }
          : { kind: "every", everyMs: 10_000 },
        deleteAfterRun: oneShot,
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: {
          kind: "agentTurn",
          message: `fixture-case:${id}`,
          model: "cron-fixture-cli/proof",
          thinking: "off",
        },
        delivery: { mode: "none" },
      });
      const baseKey = `agent:main:cron:${job.id}`;
      const release = () => fs.writeFile(path.join(control, `${id}.release`), "");
      try {
        await expect
          .poll(() => existsSync(path.join(control, `${id}.started`)), { timeout: 60_000 })
          .toBe(true);
        const base = entry(baseKey);
        expect(base).toBeDefined();
        const sessionId = base!.sessionId;
        const runKey = `${baseKey}:run:${sessionId}`;
        expect(placement(sessionId)).toMatchObject({
          session_key: runKey,
          state: "local",
          turn_claim_id: expect.any(String),
        });

        if (!oneShot) {
          await expect(call("cron.remove", { id: job.id })).resolves.toMatchObject({
            ok: true,
            removed: true,
          });
          // Removal must drain the backend still held at the file barrier before deleting its row.
          expect(entry(baseKey)?.sessionId).toBe(sessionId);
          expect(placement(sessionId)?.turn_claim_id).toEqual(expect.any(String));
        }
        await release();

        await expect
          .poll(() => ({ base: entry(baseKey), placement: placement(sessionId) }), {
            timeout: 60_000,
          })
          .toEqual({ base: undefined, placement: undefined });
        await expect
          .poll(async () => (await history(job.id)).entries, { timeout: 30_000 })
          .toEqual([
            expect.objectContaining({
              jobId: job.id,
              sessionId,
              status: oneShot ? "ok" : "error",
              ...(!oneShot ? { error: "Cron job removed by operator." } : {}),
            }),
          ]);
        if (!oneShot) {
          expect(existsSync(path.join(control, `${id}.cancelled`))).toBe(true);
          // Unpersisted terminal run state remains history, separate from the reusable base.
          expect(entry(runKey)).toMatchObject({
            sessionId,
            status: "killed",
            cronRunContinuation: { phase: "ready", basePersisted: false },
          });
        }
        const sessions = await call<SessionsListResult>("sessions.list");
        expect(sessions.sessions.map((session) => session.key)).not.toContain(baseKey);
        expect(sessions.sessions.map((session) => session.key)).not.toContain(runKey);
        const jobs = await call<{ jobs: CronJob[] }>("cron.list", { includeDisabled: true });
        expect(jobs.jobs.map((listed) => listed.id)).not.toContain(job.id);
        retainedRuns.set(job.id, (await history(job.id)).entries);
      } finally {
        await release();
      }
    }
    for (const [jobId, entries] of retainedRuns) {
      expect((await history(jobId)).entries).toEqual(entries);
    }
  }, 240_000);
});
