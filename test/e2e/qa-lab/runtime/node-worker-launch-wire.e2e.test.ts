import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { afterEach, describe, expect, it } from "vitest";
import type { AuditRunInspectResult } from "../../../../packages/gateway-protocol/src/index.js";
import {
  NODE_WORKER_BUNDLE_INSTALL_COMMAND,
  NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
  NODE_WORKER_SUPERVISOR_STATUS_COMMAND,
  NODE_WORKER_WORKSPACE_EXEC_COMMAND,
} from "../../../../src/infra/node-commands.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import {
  BASELINE_PROMPT,
  BASELINE_REPLY,
  PROOF_TIMEOUT_MS,
  WORKER_PERMISSION_PROMPT,
  WORKER_PERMISSION_REPLY,
  startMidturnProvider,
} from "./cloud-worker-midturn-loss-fixture.js";
import {
  closeWireServer,
  connectWireClient,
  createPairedNodeWorkerHost,
  createPublishedWireWorkspace,
  startPairedNodeWorkerGateway,
  type PairedNodeWorkerHost,
  type WireGateway,
  wireMessageText,
} from "./paired-node-worker-wire-fixture.js";

const execFileAsync = promisify(execFile);
const SESSION_KEY = "agent:qa:node-worker-launch-wire";
const TEST_TIMEOUT_MS = PROOF_TIMEOUT_MS + 60_000;
const CONTROL_PROBE_MAX_MS = 4_000;
const CONTROL_PROBE_P95_MS = 1_000;
const FINALIZATION_LOAD_CONCURRENCY = 12;
const FINALIZATION_LOAD_WAVES = 3;
const MIN_CONTROL_PROBE_SAMPLES = 12;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 20_000,
  });
  return stdout.trim();
}

function nearestRankPercentile(values: readonly number[], percentile: number): number {
  const sorted = values.toSorted((left, right) => left - right);
  const index = Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function requireSafeGenericDecisionDisplay(result: AuditRunInspectResult) {
  const receipt = result.decisionDisplays.find(
    (candidate) => candidate.provenance.state === "unverified",
  );
  expect(receipt).toMatchObject({
    action: { family: "decision", operation: "record" },
    decision: { outcome: "unknown", reasonCode: "decision_fact_display_unverified" },
    enforcement: { coverageState: "unknown" },
    provenance: { state: "unverified" },
    missingEvidence: ["decision.display_provenance"],
  });
  return receipt!;
}

describe("node worker launch wire", () => {
  it(
    "transfers and reconciles a gateway-push workspace through a device runner",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const root = tempDirs.make("openclaw-node-worker-launch-wire-");
      const provider = await startMidturnProvider();
      const published = await createPublishedWireWorkspace(root);
      let gateway: WireGateway | undefined;
      let operator: GatewayClient | undefined;
      let workerNode: PairedNodeWorkerHost | undefined;
      let legacyWorkerNode: PairedNodeWorkerHost | undefined;
      let reconnected = false;
      let bundlePrewarm: unknown;
      let legacyBundlePrewarm: unknown;
      let launchId: string | undefined;
      let observeFinalizationLoad = false;
      let finalizationStartedAt: number | undefined;
      let resolveWaveFinalizationStarted: ((startedAt: number) => void) | undefined;
      let workerAuditBeforeRestart: string | undefined;
      let testFailure: { error: unknown } | undefined;
      let cleanupFailures: unknown[];

      try {
        gateway = await startPairedNodeWorkerGateway({
          providerBaseUrl: provider.baseUrl,
          executionIdentity: true,
        });
        operator = await connectWireClient({ gateway, role: "operator", identity: null });
        workerNode = await createPairedNodeWorkerHost({
          gateway,
          operator,
          root,
          capacity: FINALIZATION_LOAD_CONCURRENCY,
          bundlePrewarm: true,
          onInvoke: (frame) => {
            if (frame.command === NODE_WORKER_WORKSPACE_EXEC_COMMAND && frame.paramsJSON) {
              const workspaceCommand = JSON.parse(frame.paramsJSON) as {
                transfer?: { direction?: unknown };
              };
              if (
                observeFinalizationLoad &&
                workspaceCommand.transfer?.direction === "upload" &&
                resolveWaveFinalizationStarted
              ) {
                const startedAt = performance.now();
                finalizationStartedAt ??= startedAt;
                resolveWaveFinalizationStarted(startedAt);
                resolveWaveFinalizationStarted = undefined;
              }
            }
            if (frame.command === NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND && frame.paramsJSON) {
              launchId = (JSON.parse(frame.paramsJSON) as { launchId?: string }).launchId;
            }
            if (frame.command === NODE_WORKER_BUNDLE_INSTALL_COMMAND && frame.paramsJSON) {
              bundlePrewarm = (JSON.parse(frame.paramsJSON) as { bundlePrewarm?: unknown })
                .bundlePrewarm;
            }
          },
          afterInvoke: async (frame, host) => {
            if (frame.command !== NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND || reconnected) {
              return;
            }
            reconnected = true;
            await host.disconnect();
            await host.connect();
          },
        });
        expect(workerNode.client).toBeTruthy();

        await operator.request("sessions.create", {
          key: SESSION_KEY,
          agentId: "qa",
          worktree: true,
          worktreeName: "node-worker-launch-wire",
          worktreeBaseRef: "main",
          cwd: published.source,
        });
        const created = (await gateway.call("sessions.describe", { key: SESSION_KEY })) as {
          session?: { execCwd?: string; spawnedCwd?: string };
        };
        const localWorkspaceDir = created.session?.execCwd ?? created.session?.spawnedCwd;
        expect(localWorkspaceDir).toBeTruthy();
        await fs.writeFile(
          path.join(localWorkspaceDir!, "gateway-push.txt"),
          "dirty gateway workspace\n",
        );
        const dispatched = await gateway.call(
          "sessions.dispatch",
          { key: SESSION_KEY, deviceId: workerNode.identity.deviceId },
          { timeoutMs: PROOF_TIMEOUT_MS },
        );
        const placement = (dispatched as { placement?: Record<string, unknown> }).placement;
        expect(placement).toMatchObject({
          state: "active",
          workerBundleHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        });
        const remoteWorkspaceDir = placement?.remoteWorkspaceDir;
        if (typeof remoteWorkspaceDir !== "string" || !remoteWorkspaceDir) {
          throw new Error("active worker placement did not expose a remote workspace directory");
        }
        const baseManifestRef = placement?.workspaceBaseManifestRef;
        await expect(
          fs.readFile(path.join(remoteWorkspaceDir, "gateway-push.txt"), "utf8"),
        ).resolves.toBe("dirty gateway workspace\n");
        await expect(
          fs.readFile(path.join(remoteWorkspaceDir, "nested", "tracked.txt"), "utf8"),
        ).resolves.toBe("nested tracked input\n");
        await fs.writeFile(path.join(remoteWorkspaceDir, "node-result.txt"), "device result\n");

        const runId = `node-worker-launch-wire-${Date.now()}`;
        const started = await operator.request<{ runId?: string; status?: string }>("chat.send", {
          sessionKey: SESSION_KEY,
          message: BASELINE_PROMPT,
          deliver: false,
          idempotencyKey: runId,
        });
        expect(started).toMatchObject({ runId, status: "started" });
        const completed = await operator.request<{ status?: string }>(
          "agent.wait",
          { runId, timeoutMs: PROOF_TIMEOUT_MS },
          { timeoutMs: PROOF_TIMEOUT_MS + 5_000 },
        );
        if (completed.status !== "ok") {
          throw new Error(
            `node worker turn failed: ${JSON.stringify(completed)}\n${gateway.logs().slice(-12_000)}`,
          );
        }
        await workerNode.waitForInvokes();
        expect(workerNode.invokeErrors).toEqual([]);
        expect(reconnected).toBe(true);
        expect(workerNode.commands).toContain(NODE_WORKER_BUNDLE_INSTALL_COMMAND);
        expect(workerNode.commands).toContain(NODE_WORKER_WORKSPACE_EXEC_COMMAND);
        expect(workerNode.commands).toContain(NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND);
        expect(workerNode.commands).toContain(NODE_WORKER_SUPERVISOR_STATUS_COMMAND);
        expect(launchId).toBeTruthy();
        expect(bundlePrewarm).toBe(1);
        await expect(workerNode.supervisor.status(launchId!)).resolves.toMatchObject({
          state: "completed",
        });

        workerAuditBeforeRestart = await gateway.runCli([
          "audit",
          "--run",
          runId,
          "--explain",
          "--json",
        ]);
        requireSafeGenericDecisionDisplay(
          JSON.parse(workerAuditBeforeRestart) as AuditRunInspectResult,
        );
        expect(workerAuditBeforeRestart).not.toContain(workerNode.identity.deviceId);
        expect(workerAuditBeforeRestart).not.toContain(String(placement?.workerBundleHash));
        expect(workerAuditBeforeRestart).not.toContain(SESSION_KEY);

        const history = await operator.request<{ messages?: unknown[] }>("chat.history", {
          sessionKey: SESSION_KEY,
          limit: 20,
        });
        expect(
          history.messages?.filter(
            (message) =>
              (message as { role?: unknown }).role === "assistant" &&
              wireMessageText(message).includes(BASELINE_REPLY),
          ),
        ).toHaveLength(1);
        const described = (await gateway.call("sessions.describe", { key: SESSION_KEY })) as {
          session?: { execCwd?: string; spawnedCwd?: string; placement?: Record<string, unknown> };
        };
        expect(described.session?.placement).toMatchObject({
          state: "active",
          remoteWorkspaceDir,
        });
        expect(described.session?.placement?.workspaceBaseManifestRef).not.toBe(baseManifestRef);
        const reconciledLocalDir = described.session?.execCwd ?? described.session?.spawnedCwd;
        expect(reconciledLocalDir).toBeTruthy();
        await expect(
          fs.readFile(path.join(reconciledLocalDir!, "node-result.txt"), "utf8"),
        ).resolves.toBe("device result\n");
        expect(await git(remoteWorkspaceDir, "rev-parse", "HEAD")).toBe(published.commit);
        expect(await fs.readFile(path.join(remoteWorkspaceDir, "node-result.txt"), "utf8")).toBe(
          "device result\n",
        );

        const permissionRunId = `node-worker-permission-${Date.now()}`;
        await expect(
          operator.request<{ runId?: string; status?: string }>("chat.send", {
            sessionKey: SESSION_KEY,
            message: WORKER_PERMISSION_PROMPT,
            deliver: false,
            idempotencyKey: permissionRunId,
          }),
        ).resolves.toMatchObject({ runId: permissionRunId, status: "started" });
        await expect(
          operator.request<{ status?: string }>(
            "agent.wait",
            { runId: permissionRunId, timeoutMs: PROOF_TIMEOUT_MS },
            { timeoutMs: PROOF_TIMEOUT_MS + 5_000 },
          ),
        ).resolves.toMatchObject({ status: "ok" });
        await workerNode.waitForInvokes();
        expect(workerNode.invokeErrors).toEqual([]);

        await expect(
          fs.readFile(path.join(remoteWorkspaceDir, "worker-permission-in-root.txt"), "utf8"),
        ).resolves.toBe("worker permission proof\n");
        await expect(
          fs.access(path.resolve(remoteWorkspaceDir, "..", "worker-permission-outside.txt")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
          fs.access(path.join(remoteWorkspaceDir, "worker-exec-escaped.txt")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(provider.outsideWriteOutput).toMatch(/escape|outside|containment|workspace/iu);
        expect(provider.execOutput).toMatch(
          /approval_required.*worker workspace permission mode.*run this command locally.*interactive approval.*administrator.*clear the session permission mode/isu,
        );

        const permissionHistory = await operator.request<{ messages?: unknown[] }>("chat.history", {
          sessionKey: SESSION_KEY,
          limit: 30,
        });
        const permissionReplies = permissionHistory.messages?.filter(
          (message) =>
            (message as { role?: unknown }).role === "assistant" &&
            wireMessageText(message).includes(WORKER_PERMISSION_REPLY),
        );
        expect(permissionReplies).toHaveLength(1);
        expect(wireMessageText(permissionReplies?.[0])).toContain(provider.execOutput);
        const permissionDescribed = (await gateway.call("sessions.describe", {
          key: SESSION_KEY,
        })) as { session?: { execCwd?: string; spawnedCwd?: string } };
        const permissionLocalDir =
          permissionDescribed.session?.execCwd ?? permissionDescribed.session?.spawnedCwd;
        expect(permissionLocalDir).toBeTruthy();
        await expect(
          fs.readFile(path.join(permissionLocalDir!, "worker-permission-in-root.txt"), "utf8"),
        ).resolves.toBe("worker permission proof\n");

        // Simulate the old capability declaration with the current supervisor over real wire.
        // This proves negotiation and same-identity reconnect, not an older binary upgrade.
        legacyWorkerNode = await createPairedNodeWorkerHost({
          gateway,
          operator,
          root,
          label: "legacy-node",
          environmentSession: false,
          onInvoke: (frame) => {
            if (frame.command === NODE_WORKER_BUNDLE_INSTALL_COMMAND && frame.paramsJSON) {
              legacyBundlePrewarm = (JSON.parse(frame.paramsJSON) as { bundlePrewarm?: unknown })
                .bundlePrewarm;
            }
          },
        });
        const legacySessionKey = `${SESSION_KEY}-legacy-node`;
        await operator.request("sessions.create", {
          key: legacySessionKey,
          agentId: "qa",
          worktree: true,
          worktreeName: "node-worker-launch-legacy-node",
          worktreeBaseRef: "main",
          cwd: published.source,
        });
        await gateway.call(
          "sessions.dispatch",
          { key: legacySessionKey, deviceId: legacyWorkerNode.identity.deviceId },
          { timeoutMs: PROOF_TIMEOUT_MS },
        );
        const unsupportedRunId = `node-worker-lifetime-unsupported-${Date.now()}`;
        await expect(
          operator.request("chat.send", {
            sessionKey: legacySessionKey,
            message: BASELINE_PROMPT,
            deliver: false,
            idempotencyKey: unsupportedRunId,
          }),
        ).resolves.toMatchObject({ runId: unsupportedRunId, status: "started" });
        await expect(
          operator.request(
            "agent.wait",
            { runId: unsupportedRunId, timeoutMs: PROOF_TIMEOUT_MS },
            { timeoutMs: PROOF_TIMEOUT_MS + 5_000 },
          ),
        ).resolves.toMatchObject({
          status: "error",
          error: expect.stringMatching(
            /requires an update.*openclaw update.*reconnect.*openclaw node restart/su,
          ),
        });
        await legacyWorkerNode.waitForInvokes();
        expect(legacyWorkerNode.commands).not.toContain(NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND);
        await expect(
          gateway.call("sessions.describe", { key: legacySessionKey }),
        ).resolves.toMatchObject({ session: { placement: { state: "active" } } });

        await legacyWorkerNode.disconnect();
        await legacyWorkerNode.connect({ environmentSession: true });
        const legacyRunId = `node-worker-launch-wire-legacy-${Date.now()}`;
        await operator.request("chat.send", {
          sessionKey: legacySessionKey,
          message: BASELINE_PROMPT,
          deliver: false,
          idempotencyKey: legacyRunId,
        });
        await expect(
          operator.request<{ status?: string }>(
            "agent.wait",
            { runId: legacyRunId, timeoutMs: PROOF_TIMEOUT_MS },
            { timeoutMs: PROOF_TIMEOUT_MS + 5_000 },
          ),
        ).resolves.toMatchObject({ status: "ok" });
        await legacyWorkerNode.waitForInvokes();
        expect(legacyWorkerNode.invokeErrors).toEqual([]);
        expect(legacyWorkerNode.commands).toContain(NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND);
        expect(legacyBundlePrewarm).toBeUndefined();
        const legacyHistory = await operator.request<{ messages?: unknown[] }>("chat.history", {
          sessionKey: legacySessionKey,
          limit: 20,
        });
        expect(
          legacyHistory.messages?.filter(
            (message) =>
              isRecord(message) &&
              message.role === "assistant" &&
              wireMessageText(message).includes(BASELINE_REPLY),
          ),
        ).toHaveLength(1);

        const loadSessions: string[] = [];
        for (let index = 0; index < FINALIZATION_LOAD_CONCURRENCY; index += 1) {
          const sessionKey = `${SESSION_KEY}-load-${index}`;
          await operator.request("sessions.create", {
            key: sessionKey,
            agentId: "qa",
            worktree: true,
            worktreeName: `node-worker-launch-load-${index}`,
            worktreeBaseRef: "main",
            cwd: published.source,
          });
          await gateway.call(
            "sessions.dispatch",
            { key: sessionKey, deviceId: workerNode.identity.deviceId },
            { timeoutMs: PROOF_TIMEOUT_MS },
          );
          loadSessions.push(sessionKey);
        }
        observeFinalizationLoad = true;
        const readyzSamples: Array<{ atMs: number; latencyMs: number; status: number }> = [];
        const samplerAbort = new AbortController();
        const httpOrigin = gateway.wsUrl.replace(/^ws/u, "http");
        const sampler = (async () => {
          while (!samplerAbort.signal.aborted) {
            const startedAt = performance.now();
            try {
              const response = await fetch(`${httpOrigin}/readyz`, {
                signal: AbortSignal.timeout(CONTROL_PROBE_MAX_MS),
              });
              readyzSamples.push({
                atMs: startedAt,
                latencyMs: performance.now() - startedAt,
                status: response.status,
              });
            } catch {
              readyzSamples.push({
                atMs: startedAt,
                latencyMs: performance.now() - startedAt,
                status: 0,
              });
            }
            await delay(50);
          }
        })();
        const freshConnectionSamples: number[] = [];
        try {
          for (let wave = 0; wave < FINALIZATION_LOAD_WAVES; wave += 1) {
            const waveFinalizationStarted = new Promise<number>((resolve) => {
              resolveWaveFinalizationStarted = resolve;
            });
            const loadRunIds = await Promise.all(
              loadSessions.map(async (sessionKey, index) => {
                const loadRunId = `node-worker-finalization-load-${wave}-${index}-${Date.now()}`;
                const loadStarted = await operator!.request<{ runId?: string; status?: string }>(
                  "chat.send",
                  {
                    sessionKey,
                    message: BASELINE_PROMPT,
                    deliver: false,
                    idempotencyKey: loadRunId,
                  },
                );
                expect(loadStarted).toMatchObject({ runId: loadRunId, status: "started" });
                return loadRunId;
              }),
            );
            const waits = Promise.all(
              loadRunIds.map(async (loadRunId) => {
                const completedLoad = await operator!.request<{ status?: string }>(
                  "agent.wait",
                  { runId: loadRunId, timeoutMs: PROOF_TIMEOUT_MS },
                  { timeoutMs: PROOF_TIMEOUT_MS + 5_000 },
                );
                expect(completedLoad.status).toBe("ok");
              }),
            );
            await waveFinalizationStarted;
            const freshConnectionStartedAt = performance.now();
            const freshClient = await connectWireClient({
              gateway,
              role: "operator",
              identity: null,
              timeoutMs: CONTROL_PROBE_MAX_MS,
            });
            freshConnectionSamples.push(performance.now() - freshConnectionStartedAt);
            await freshClient.stopAndWait({ timeoutMs: 2_000 });
            await waits;
          }
        } finally {
          samplerAbort.abort();
          await Promise.allSettled([sampler]);
        }
        const finalizationSamples = readyzSamples.filter(
          (sample) => sample.atMs >= (finalizationStartedAt ?? Number.POSITIVE_INFINITY),
        );
        expect(finalizationSamples.length).toBeGreaterThanOrEqual(MIN_CONTROL_PROBE_SAMPLES);
        expect(finalizationSamples.every((sample) => sample.status === 200)).toBe(true);
        const readyzLatencies = finalizationSamples.map((sample) => sample.latencyMs);
        expect(nearestRankPercentile(readyzLatencies, 95)).toBeLessThan(CONTROL_PROBE_P95_MS);
        expect(Math.max(...readyzLatencies)).toBeLessThan(CONTROL_PROBE_MAX_MS);
        expect(Math.max(...freshConnectionSamples)).toBeLessThan(CONTROL_PROBE_MAX_MS);
        expect(freshConnectionSamples).toHaveLength(FINALIZATION_LOAD_WAVES);

        await workerNode.stop();
        workerNode = undefined;
        await legacyWorkerNode.stop();
        legacyWorkerNode = undefined;
        await operator.stopAndWait({ timeoutMs: 2_000 });
        operator = undefined;
        await gateway.restartAfterStateMutation(async () => {});
        const workerAuditAfterRestart = await gateway.runCli([
          "audit",
          "--run",
          runId,
          "--explain",
          "--json",
        ]);
        requireSafeGenericDecisionDisplay(
          JSON.parse(workerAuditAfterRestart) as AuditRunInspectResult,
        );
        expect(workerAuditAfterRestart).toBe(workerAuditBeforeRestart);
      } catch (error) {
        testFailure = { error };
      } finally {
        const cleanup = await Promise.allSettled([
          workerNode?.stop() ?? Promise.resolve(),
          legacyWorkerNode?.stop() ?? Promise.resolve(),
          operator?.stopAndWait({ timeoutMs: 2_000 }) ?? Promise.resolve(),
          gateway?.stop() ?? Promise.resolve(),
          provider.stop(),
          closeWireServer(published.server),
        ]);
        cleanupFailures = cleanup.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
      }
      const failures = [...(testFailure ? [testFailure.error] : []), ...cleanupFailures];
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "node worker launch wire test failed");
      }
    },
  );
});
