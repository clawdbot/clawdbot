import { watch, type FSWatcher } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isRfc1918Ipv4Address } from "@openclaw/net-policy/ip";
import type { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createQaGatewayChild,
  startQaMockOpenAiServer,
} from "../../../../extensions/qa-lab/api.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../../../src/infra/kysely-sync.js";
import {
  pickMatchingExternalInterfaceAddress,
  readNetworkInterfaces,
} from "../../../../src/infra/network-interfaces.js";
import {
  NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
  NODE_WORKER_WORKSPACE_PREPARE_COMMAND,
} from "../../../../src/infra/node-commands.js";
import { withOpenClawStateDatabaseReadOnly } from "../../../../src/state/openclaw-state-db-readonly.js";
import type { DB as StateDatabase } from "../../../../src/state/openclaw-state-db.generated.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { MODEL_REF, PROOF_TIMEOUT_MS } from "./cloud-worker-midturn-loss-fixture.js";
import {
  closeWireServer,
  connectWireClient,
  createPublishedWireWorkspace,
  type PublishedWireWorkspace,
  type WireGateway,
  wireMessageText,
} from "./paired-node-worker-wire-fixture.js";
import { startPreparedPoolWireProvider } from "./prepared-pool-wire-provider.js";
import {
  createProductionGatewayArtifact,
  PRODUCTION_GATEWAY_ARTIFACT_TIMEOUT_MS,
} from "./production-gateway-artifact.js";

const PLUGIN_ID = "qa-prepared-pool";
const PROFILE = "prepared-wire";
const WAIT = { timeout: PROOF_TIMEOUT_MS, interval: 100 };
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function readEnvironments(gateway: WireGateway) {
  return withOpenClawStateDatabaseReadOnly(
    ({ db }) =>
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<StateDatabase>(db)
          .selectFrom("worker_environments")
          .select([
            "environment_id",
            "lease_id",
            "node_device_id",
            "state",
            "preparation_key",
            "preparation_consumed_at_ms",
            "last_activated_at_ms",
            "attached_session_ids_json",
          ])
          .where("provider_id", "=", PLUGIN_ID),
      ).rows,
    { env: gateway.runtimeEnv },
  );
}

type Placement = {
  state: string;
  environmentId: string;
  remoteWorkspaceDir: string;
};

describe("prepared pool real Gateway wire", () => {
  let production: Awaited<
    ReturnType<ReturnType<typeof createProductionGatewayArtifact>["prepare"]>
  >;
  let artifact: ReturnType<typeof createProductionGatewayArtifact> | undefined;
  let gatewayHost: string;
  beforeAll(async () => {
    const host = pickMatchingExternalInterfaceAddress(readNetworkInterfaces(), {
      family: "IPv4",
      matches: isRfc1918Ipv4Address,
    });
    if (!host) {
      throw new Error("Prepared pool wire proof requires a private non-loopback IPv4 interface");
    }
    gatewayHost = host;
    artifact = createProductionGatewayArtifact(process.cwd());
    production = await artifact.prepare();
  }, PRODUCTION_GATEWAY_ARTIFACT_TIMEOUT_MS);
  afterAll(async () => await artifact?.stop());
  it(
    "automatically prepares after activation, consumes the reserve, and reconciles its first command",
    { timeout: PROOF_TIMEOUT_MS + 180_000 },
    async () => {
      const root = await fs.realpath(tempDirs.make("openclaw-prepared-pool-wire-"));
      const gatewayOwner = createQaGatewayChild();
      let gateway: WireGateway | undefined;
      let workerGatewayUrl = "";
      let operator: GatewayClient | undefined;
      let published: PublishedWireWorkspace | undefined;
      let model: Awaited<ReturnType<typeof startQaMockOpenAiServer>> | undefined;
      let provider: Awaited<ReturnType<typeof startPreparedPoolWireProvider>> | undefined;
      let commandWatcher: FSWatcher | undefined;
      let timings: Record<string, number | null> | undefined;
      const failures: unknown[] = [];
      try {
        published = await createPublishedWireWorkspace(root);
        model = await startQaMockOpenAiServer({ modelRefs: [MODEL_REF] });
        provider = await startPreparedPoolWireProvider(root);
        const providerConfig = provider.config;
        const pluginDir = path.join(
          production.repoRoot,
          "test/e2e/qa-lab/runtime/fixtures/prepared-pool-provider",
        );
        gateway = await gatewayOwner.start({
          repoRoot: production.repoRoot,
          command: {
            executablePath: process.execPath,
            argsPrefix: [path.join(production.repoRoot, "dist/index.js")],
            argsSuffix: ["--bind", "lan"],
            cwd: production.repoRoot,
            usePackagedPlugins: true,
          },
          providerBaseUrl: `${model.baseUrl}/v1`,
          providerMode: "mock-openai",
          primaryModel: MODEL_REF,
          alternateModel: MODEL_REF,
          transportBaseUrl: "http://127.0.0.1",
          controlUiEnabled: false,
          mutateConfig: (config) => {
            workerGatewayUrl = `ws://${gatewayHost}:${config.gateway?.port}`;
            return {
              ...config,
              gateway: {
                ...config.gateway,
                bind: "lan",
                remote: { ...config.gateway?.remote, url: workerGatewayUrl },
              },
              plugins: {
                ...config.plugins,
                allow: [...new Set([...(config.plugins?.allow ?? []), PLUGIN_ID])],
                load: { ...config.plugins?.load, paths: [pluginDir] },
                entries: {
                  ...config.plugins?.entries,
                  [PLUGIN_ID]: { enabled: true, config: providerConfig },
                },
              },
              cloudWorkers: {
                profiles: {
                  [PROFILE]: { provider: PLUGIN_ID, install: "bundle", readyWorkers: 1 },
                },
                preparedPool: { maxTotal: 1 },
              },
              tools: { ...config.tools, exec: { ...config.tools?.exec, mode: "full" } },
              nodeHost: { ...config.nodeHost, workerRuns: { enabled: true } },
            };
          },
        });
        operator = await connectWireClient({ gateway, role: "operator", identity: null });
        // The enrolled node must use the real advertised interface, including the setup URL check.
        provider.connect({ ...gateway, wsUrl: workerGatewayUrl }, operator);
        const createSession = async (suffix: string) => {
          const key = `agent:qa:prepared-pool-wire-${suffix}`;
          await gateway!.call("sessions.create", {
            key,
            agentId: "qa",
            worktree: true,
            permissionMode: "full",
            worktreeName: `prepared-pool-${suffix}`,
            worktreeBaseRef: "main",
            cwd: published!.source,
          });
          const described = (await gateway!.call("sessions.describe", { key })) as {
            session: { sessionId: string; execCwd?: string; spawnedCwd?: string };
          };
          const localPath = described.session.execCwd ?? described.session.spawnedCwd;
          if (!localPath) {
            throw new Error("Session did not expose its managed worktree");
          }
          return { key, localPath, sessionId: described.session.sessionId };
        };
        const dispatch = async (key: string) =>
          (await gateway!.call(
            "sessions.dispatch",
            { key, profileId: PROFILE },
            { timeoutMs: PROOF_TIMEOUT_MS },
          )) as { placement: Placement };

        // Demand must come from real successful activation; no environment or ready rows are seeded.
        expect(readEnvironments(gateway)).toEqual([]);
        const first = await createSession("first");
        const coldStartedAt = performance.now();
        const cold = (await dispatch(first.key)).placement;
        const coldActiveAt = performance.now();
        expect(cold.state).toBe("active");
        expect(
          readEnvironments(gateway).find((row) => row.environment_id === cold.environmentId),
        ).toMatchObject({ state: "attached", last_activated_at_ms: expect.any(Number) });
        const ready = await vi.waitFor(() => {
          const row = readEnvironments(gateway!).find(
            (candidate) =>
              candidate.state === "ready" &&
              candidate.preparation_key !== null &&
              candidate.preparation_consumed_at_ms === null,
          );
          expect(row, "Automatic refill never produced a ready dedicated node").toBeDefined();
          return row!;
        }, WAIT);
        const lease = provider.leases.get(ready.lease_id!);
        expect(lease).toMatchObject({
          allocations: 1,
          provisions: 1,
          enrollments: 1,
          destroyed: false,
        });
        expect(lease?.uploads).toBeGreaterThan(0);
        expect(lease?.scripts).toBeGreaterThan(0);
        expect(lease?.host?.identity.deviceId).toBe(ready.node_device_id);
        const prepared = lease!.prepared!;
        expect(prepared.preparationKey).toBe(ready.preparation_key);
        expect(
          lease!.host!.frames.filter(
            (frame) =>
              frame.command === NODE_WORKER_WORKSPACE_PREPARE_COMMAND &&
              JSON.parse(frame.paramsJSON!).action === "register",
          ),
        ).toHaveLength(1);
        const preparationCalls = { scripts: lease!.scripts, uploads: lease!.uploads };

        const second = await createSession("second");
        await fs.writeFile(path.join(second.localPath, "session-overlay.txt"), "second session\n");
        const beforeClaim = readEnvironments(gateway);
        expect(
          beforeClaim.filter(
            (row) => row.preparation_key !== null && row.preparation_consumed_at_ms === null,
          ),
        ).toEqual([ready]);
        const existingEnvironmentIds = new Set(beforeClaim.map((row) => row.environment_id));
        const warmStartedAt = performance.now();
        const warm = (await dispatch(second.key)).placement;
        const warmActiveAt = performance.now();
        expect(warm).toMatchObject({
          state: "active",
          environmentId: ready.environment_id,
          remoteWorkspaceDir: prepared.workspaceDir,
        });
        expect(lease).toMatchObject({
          allocations: 1,
          provisions: 1,
          enrollments: 1,
          ...preparationCalls,
        });
        expect(
          readEnvironments(gateway).find((row) => row.environment_id === ready.environment_id),
        ).toMatchObject({
          state: "attached",
          lease_id: ready.lease_id,
          node_device_id: ready.node_device_id,
          preparation_consumed_at_ms: expect.any(Number),
          last_activated_at_ms: expect.any(Number),
          attached_session_ids_json: JSON.stringify([second.sessionId]),
        });
        await expect(
          fs.readFile(path.join(prepared.workspaceDir, "session-overlay.txt"), "utf8"),
        ).resolves.toBe("second session\n");

        const command = "printf PREPARED_COMMAND_OK > prepared-command.txt";
        const runId = "prepared-pool-first-command";
        const beforeTurn = await operator.request<{ messages: unknown[] }>("chat.history", {
          sessionKey: second.key,
        });
        let firstCommandEffectObservedAt: number | undefined;
        try {
          commandWatcher = watch(prepared.workspaceDir, (_event, filename) => {
            if (filename === "prepared-command.txt") {
              firstCommandEffectObservedAt ??= performance.now();
            }
          });
          commandWatcher.once("error", () => {
            firstCommandEffectObservedAt = undefined;
            commandWatcher?.close();
            commandWatcher = undefined;
          });
        } catch {
          // Optional filesystem observation cannot replace the exact remote/local byte proof.
        }
        await operator.request("chat.send", {
          sessionKey: second.key,
          message: `Tool progress QA check. Call the exec tool exactly once with this exact command before answering: \`${command}\`. Reply exactly: PREPARED_TURN_OK`,
          deliver: false,
          idempotencyKey: runId,
        });
        const outcome = await operator.request<{ status: string }>(
          "agent.wait",
          { runId, timeoutMs: PROOF_TIMEOUT_MS },
          { timeoutMs: PROOF_TIMEOUT_MS + 5_000 },
        );
        expect(outcome).toMatchObject({ status: "ok" });
        commandWatcher?.close();
        commandWatcher = undefined;
        await lease!.host!.waitForWorkersIdle();
        await lease!.host!.waitForInvokes();
        expect(lease!.host!.invokeErrors).toEqual([]);
        expect(lease!.host!.commands).toContain(NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND);
        for (const workspace of [prepared.workspaceDir, second.localPath]) {
          await expect(
            fs.readFile(path.join(workspace, "prepared-command.txt"), "utf8"),
          ).resolves.toBe("PREPARED_COMMAND_OK");
        }
        await expect(
          fs.access(path.join(first.localPath, "prepared-command.txt")),
        ).rejects.toThrow();
        const history = await operator.request<{ messages: Array<{ role?: string }> }>(
          "chat.history",
          {
            sessionKey: second.key,
          },
        );
        const reply = history.messages
          .slice(beforeTurn.messages.length)
          .findLast((message) => message.role === "assistant");
        expect(reply).toBeDefined();
        expect(wireMessageText(reply)).toBe("PREPARED_TURN_OK");
        expect(lease).toMatchObject({
          allocations: 1,
          provisions: 1,
          enrollments: 1,
          ...preparationCalls,
        });
        // A successful claim starts another refill; it must own a different unassigned environment.
        const replacement = await vi.waitFor(() => {
          const row = readEnvironments(gateway!).find(
            (candidate) =>
              !existingEnvironmentIds.has(candidate.environment_id) &&
              candidate.state === "ready" &&
              candidate.preparation_consumed_at_ms === null,
          );
          expect(row).toBeDefined();
          return row!;
        }, WAIT);
        expect(replacement.environment_id).not.toBe(ready.environment_id);
        expect(replacement.lease_id).not.toBe(ready.lease_id);
        expect(replacement.node_device_id).not.toBe(ready.node_device_id);
        expect(replacement.attached_session_ids_json).toBe("[]");
        timings = {
          coldDispatchToActiveMs: coldActiveAt - coldStartedAt,
          warmDispatchToActiveMs: warmActiveAt - warmStartedAt,
          warmDispatchToFirstCommandEffectObservedMs:
            firstCommandEffectObservedAt === undefined
              ? null
              : firstCommandEffectObservedAt - warmStartedAt,
        };
      } catch (error) {
        failures.push(error);
        if (gateway) {
          process.stderr.write(gateway.logs().slice(-12_000));
        }
      } finally {
        commandWatcher?.close();
        // Stop the Gateway producer before draining allocation requests and physical node owners.
        for (const cleanup of [
          () => stopQaGatewayFixture(gatewayOwner),
          () => provider?.stop(),
          () => operator?.stopAndWait({ timeoutMs: 2_000 }),
          () => model?.stop(),
          () => published && closeWireServer(published.server),
        ]) {
          try {
            await cleanup();
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (failures.length) {
        throw new AggregateError(failures, "Prepared pool wire proof failed");
      }
      process.stdout.write(
        `${JSON.stringify({
          proof: "synthetic-provider-loopback-prepared-pool",
          status: "passed",
          ...timings,
        })}\n`,
      );
    },
  );
});
