import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runUpdateCommandRepair } from "../cli/update-cli/update-command-repair.js";
import { admitUpdateCommandRun } from "../cli/update-cli/update-command-run.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { toErrorObject } from "./errors.js";
import { UPDATE_RUN_ID_ENV } from "./update-control-plane-sentinel.js";
import { prepareUnattendedUpdateRepair } from "./update-repair-agent.js";
import type { UpdateRepairEvent, UpdateRepairParams } from "./update-repair-protocol.js";
import * as requesterOwner from "./update-requester-authority.js";
import { createUpdateRun, getUpdateRun, recordUpdateRunPhase } from "./update-run-ledger.js";

async function candidate(root: string, runtime: string) {
  const directory = path.join(root, "dist/infra");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "update-repair.worker.js"),
    'import "./candidate-runtime.mjs";',
  );
  await fs.writeFile(path.join(directory, "candidate-runtime.mjs"), runtime);
}

function repairParams(state: {
  stateDir: string;
  configPath: string;
  workspaceDir: string;
}): UpdateRepairParams {
  return {
    target: { ...state, installRoot: state.workspaceDir },
    context: { error: "Synthetic startup failure", phase: "verifying" },
    budget: { maxTurns: 1, wallClockMs: 10_000 },
    validate: async () => ({ ok: false, score: 0, summary: "Service stopped" }),
  };
}

describe("fresh candidate repair process", () => {
  it.each([
    {
      source: "external",
      requester: { channel: "synthetic", senderId: "owner" },
      needsAuthority: true,
    },
    {
      source: "internal",
      requester: { channel: "webchat", senderId: "owner" },
      needsAuthority: false,
    },
    { source: "channel-less", requester: { senderId: "owner" }, needsAuthority: false },
  ])(
    "preserves $source requester authority through replacement and candidate repair",
    async ({ requester, needsAuthority }) => {
      await withOpenClawTestState(
        {
          prefix: "repair-child-boundary-",
          layout: "home",
          env: { [UPDATE_RUN_ID_ENV]: undefined },
        },
        async (state) => {
          await state.writeConfig({
            commands: { ownerAllowFrom: needsAuthority ? ["owner"] : [] },
            plugins: { enabled: false },
            agents: { defaults: { model: { primary: "unconfigured/repair" } } },
          });
          const obsolete = path.join(state.workspaceDir, "old-runtime.mjs");
          await fs.writeFile(
            obsolete,
            'throw new Error("Old runtime cannot execute after replacement");',
          );
          await candidate(
            state.workspaceDir,
            `
        import fs from "node:fs";
        let start;
        const send = message => process.send(message);
        process.on("message", message => {
          if (message.type === "start") {
            start = message;
            const expectedRequester = ${JSON.stringify(needsAuthority ? requester : null)};
            if (JSON.stringify(start.requester ?? null) !== JSON.stringify(expectedRequester)) process.exit(8);
            fs.writeFileSync("child-pid", String(process.pid));
            send({ type: "validate", id: 1 });
          } else if (message.type === "validation-result" && message.id === 1) {
            send({ type: "event", event: { type: "turn-started", turn: 1, provider: "openai", model: "gpt-5.6-luna" } });
            fs.writeFileSync("candidate-repaired", start.target.stateDir);
            send({ type: "validate", id: 2 });
          } else if (message.type === "validation-result" && message.id === 2) {
            const attempt = { turn: 1, provider: "openai", model: "gpt-5.6-luna", durationMs: 1, toolCalls: 1, validation: message.validation, summary: "Candidate repair completed." };
            send({ type: "event", event: { type: "turn-finished", ...attempt } });
            send({ type: "event", event: { type: "stopped", status: "repaired" } });
            process.send({ type: "result", result: { status: "repaired", attempts: [attempt], finalValidation: message.validation } }, () => process.disconnect());
          }
        });
        send({ type: "ready" });
      `,
          );
          const prepareAuthority = requesterOwner.createManagedUpdateRequesterAuthority;
          // A late factory call would import chunks removed by replacement. Keep
          // that module-availability boundary observable without touching this checkout.
          const prepare = vi
            .spyOn(requesterOwner, "createManagedUpdateRequesterAuthority")
            .mockImplementation(async (...args) => {
              await fs.access(obsolete);
              return prepareAuthority(...args);
            });
          try {
            const requested = createUpdateRun(
              {
                trigger: needsAuthority ? "chat" : "api",
                origin: { requester },
              },
              { env: state.env },
            );
            process.env[UPDATE_RUN_ID_ENV] = requested.runId;
            const run = await admitUpdateCommandRun({ opts: {}, root: state.workspaceDir });
            // The candidate passed staging without entering repair. Its first repair
            // occurs only after activation, when the parent cannot load old modules.
            recordUpdateRunPhase(
              run.runId,
              "validating",
              {
                step: { step: "candidate validation", status: "completed" },
              },
              { env: run.env },
            );
            recordUpdateRunPhase(run.runId, "verifying", undefined, { env: run.env });
            expect(getUpdateRun(run.runId, { env: run.env })?.repair).toEqual([]);
            await fs.rm(obsolete);
            const events: UpdateRepairEvent[] = [];
            let validations = 0;
            let restarts = 0;
            const result = await runUpdateCommandRepair({
              root: state.workspaceDir,
              env: run.env,
              run,
              phase: "verifying",
              result: {
                status: "error",
                mode: "npm",
                root: state.workspaceDir,
                reason: "startup-failed",
                steps: [],
                durationMs: 0,
              },
              onEvent: (event) => events.push(event),
              validate: async (signal) => {
                signal.throwIfAborted();
                validations += 1;
                const childPid = Number(
                  await fs.readFile(path.join(state.workspaceDir, "child-pid"), "utf8"),
                );
                expect(childPid).not.toBe(process.pid);
                const repaired = await fs
                  .readFile(path.join(state.workspaceDir, "candidate-repaired"), "utf8")
                  .catch(() => "");
                if (repaired) {
                  expect(repaired).toBe(state.stateDir);
                  expect(events.at(-1)?.type).toBe("turn-started");
                  restarts += 1;
                }
                return {
                  ok: Boolean(repaired),
                  score: repaired ? 1 : 0,
                  summary: repaired ? "Parent verified restart" : "Service stopped",
                };
              },
            });
            expect(result).toMatchObject({
              status: "repaired",
              attempts: [{ validation: { ok: true } }],
            });
            expect(validations).toBe(2);
            expect(restarts).toBe(1);
            expect(prepare).toHaveBeenCalledTimes(needsAuthority ? 1 : 0);
            expect(getUpdateRun(run.runId, { env: run.env })?.origin.requester).toEqual(requester);
            expect(getUpdateRun(run.runId, { env: run.env })?.repair).toEqual([
              expect.objectContaining({ status: "succeeded" }),
            ]);
            expect(events.map((event) => event.type)).toEqual([
              "turn-started",
              "turn-finished",
              "stopped",
            ]);
          } finally {
            prepare.mockRestore();
          }
        },
      );
    },
  );

  it("cancels the child and drains the parent oracle before returning", async () => {
    await withOpenClawTestState(
      { prefix: "repair-child-cancel-", layout: "home" },
      async (state) => {
        await candidate(
          state.workspaceDir,
          `
        process.on("message", message => {
          if (message.type === "start") process.send({ type: "validate", id: 1 });
        });
        process.send({ type: "ready" });
      `,
        );
        const controller = new AbortController();
        let admitted!: () => void;
        const entered = new Promise<void>((resolve) => {
          admitted = resolve;
        });
        let drained = false;
        const pending = prepareUnattendedUpdateRepair({
          ...repairParams(state),
          signal: controller.signal,
          validate: (signal) =>
            new Promise((_, reject) => {
              signal.addEventListener(
                "abort",
                () => {
                  drained = true;
                  reject(toErrorObject(signal.reason, "Repair validation cancelled."));
                },
                { once: true },
              );
              admitted();
            }),
        });
        await entered;
        await expect(prepareUnattendedUpdateRepair(repairParams(state))).resolves.toMatchObject({
          status: "unavailable",
          reason: "Another installation repair is already running.",
        });
        controller.abort(new Error("repair-cancelled"));
        await expect(pending).resolves.toMatchObject({
          status: "aborted",
          reason: "repair-cancelled",
        });
        expect(drained).toBe(true);
      },
    );
  });

  it("records an unavailable candidate worker instead of falling back to old imports", async () => {
    await withOpenClawTestState(
      { prefix: "repair-child-missing-", layout: "home" },
      async (state) => {
        const events: UpdateRepairEvent[] = [];
        const result = await prepareUnattendedUpdateRepair({
          ...repairParams(state),
          onEvent: (event) => events.push(event),
        });
        expect(result.status).toBe("unavailable");
        expect(events).toEqual([
          expect.objectContaining({ type: "stopped", status: "unavailable" }),
        ]);
      },
    );
  });
});
