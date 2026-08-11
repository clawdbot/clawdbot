// Gateway agent and artifact API tests cover composed RPC behavior through a real server.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../../../src/config/config.js";
import { resolveStorePath } from "../../../../src/config/sessions/paths.js";
import {
  appendTranscriptMessage,
  upsertSessionEntry,
} from "../../../../src/config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../../../../src/config/sessions/store-writer-state.js";
import { createManagedOutgoingMediaBlocks } from "../../../../src/gateway/managed-image-attachments.js";
import { ADMIN_SCOPE, READ_SCOPE } from "../../../../src/gateway/method-scopes.js";
import { startGatewayServer } from "../../../../src/gateway/server.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  getGatewayE2ePortBlock,
} from "../../../../src/gateway/test-helpers.e2e.js";
import { GATEWAY_STARTUP_MUTATED_ENV_KEYS } from "../../../../src/gateway/test-helpers.env.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../../src/state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../../../src/state/openclaw-state-db.js";
import { createTaskRecord, deleteTaskRecordById } from "../../../../src/tasks/task-registry.js";
import { captureEnv, setTestEnvValue } from "../../../../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

type WorkerRecord = {
  environmentId: string;
  providerId: string;
  leaseId: string | null;
  state:
    | "requested"
    | "provisioning"
    | "bootstrapping"
    | "ready"
    | "attached"
    | "idle"
    | "draining"
    | "destroying"
    | "destroyed"
    | "failed"
    | "orphaned";
  ownerEpoch: number;
  createdAtMs: number;
  idleSinceAtMs: number | null;
  attachedSessionIds: readonly string[];
  tunnelStatus: "stopped" | "connecting" | "connected" | "reconnecting";
};

const injectedWorkerService = vi.hoisted(() => {
  const records = new Map<string, WorkerRecord>();
  const idempotency = new Map<string, string>();
  let createCount = 0;

  const service = {
    list: () => [...records.values()],
    get: (environmentId: string) => records.get(environmentId),
    create: async (profileId: string, idempotencyKey: string) => {
      const existingId = idempotency.get(idempotencyKey);
      if (existingId) {
        return records.get(existingId)!;
      }
      createCount += 1;
      const environmentId = `worker-qa-${createCount}`;
      const record: WorkerRecord = {
        environmentId,
        providerId: profileId,
        leaseId: `lease-${createCount}`,
        state: "ready",
        ownerEpoch: 1,
        createdAtMs: 1_800_000_000_000,
        idleSinceAtMs: null,
        attachedSessionIds: [],
        tunnelStatus: "stopped",
      };
      records.set(environmentId, record);
      idempotency.set(idempotencyKey, environmentId);
      return record;
    },
    destroyUnattached: async (environmentId: string) => {
      const current = records.get(environmentId);
      if (!current) {
        throw Object.assign(new Error("unknown environment"), {
          code: "environment_not_found",
        });
      }
      const destroyed = { ...current, state: "destroyed" as const };
      records.set(environmentId, destroyed);
      return destroyed;
    },
  };

  return {
    service,
    createCount: () => createCount,
    reset: () => {
      records.clear();
      idempotency.clear();
      createCount = 0;
    },
  };
});

vi.mock("../../../../src/gateway/server-request-context.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../../src/gateway/server-request-context.js")
  >("../../../../src/gateway/server-request-context.js");
  return {
    ...actual,
    createGatewayRequestContext: (
      params: Parameters<typeof actual.createGatewayRequestContext>[0],
    ) => {
      const context = actual.createGatewayRequestContext(params);
      // The context contract is the runtime owner of environment RPC dependencies.
      context.workerEnvironmentService = injectedWorkerService.service as never;
      return context;
    },
  };
});

const ENV_KEYS = [
  "HOME",
  ...GATEWAY_STARTUP_MUTATED_ENV_KEYS,
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_GATEWAY_PASSWORD",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
] as const;

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WnXcZ0AAAAASUVORK5CYII=";

type Cleanup = () => Promise<void> | void;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Gateway agent and artifact APIs", () => {
  const cleanup: Cleanup[] = [];

  beforeEach(() => {
    injectedWorkerService.reset();
  });

  afterEach(async () => {
    for (const step of cleanup.splice(0).toReversed()) {
      await step();
    }
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    clearSessionStoreCacheForTest();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
  });

  it("composes agent, environment, and artifact RPCs over one real Gateway", async () => {
    const envSnapshot = captureEnv([...ENV_KEYS]);
    cleanup.push(() => envSnapshot.restore());

    const tempHome = tempDirs.make("gateway-agent-artifacts-");
    const stateDir = path.join(tempHome, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    const mainWorkspace = path.join(tempHome, "workspace-main");
    const createdWorkspace = path.join(tempHome, "workspace-artifact-agent");
    const token = "gateway-agent-artifacts-token";
    await fs.mkdir(mainWorkspace, { recursive: true });
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          gateway: { auth: { mode: "token", token } },
          agents: {
            entries: {
              main: { default: true, workspace: mainWorkspace },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    setTestEnvValue("HOME", tempHome);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
    setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", token);
    setTestEnvValue("OPENCLAW_SKIP_CHANNELS", "1");
    setTestEnvValue("OPENCLAW_SKIP_GMAIL_WATCHER", "1");
    setTestEnvValue("OPENCLAW_SKIP_CRON", "1");
    setTestEnvValue("OPENCLAW_SKIP_CANVAS_HOST", "1");
    setTestEnvValue("OPENCLAW_SKIP_BROWSER_CONTROL_SERVER", "1");
    setTestEnvValue("OPENCLAW_SKIP_PROVIDERS", "1");
    setTestEnvValue("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    clearSessionStoreCacheForTest();

    const port = await getGatewayE2ePortBlock();
    setTestEnvValue("OPENCLAW_GATEWAY_PORT", String(port));
    let server = await startGatewayServer(port, {
      bind: "loopback",
      auth: { mode: "token", token },
      controlUiEnabled: false,
    });
    cleanup.push(() => server.close());

    let client = await connectGatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token,
      clientDisplayName: "gateway agent artifact APIs",
      scopes: [ADMIN_SCOPE, READ_SCOPE],
      timeoutMs: 30_000,
    });
    cleanup.push(() => disconnectGatewayClient(client));
    const restartGateway = async (clientDisplayName: string) => {
      await disconnectGatewayClient(client);
      await server.close();
      clearRuntimeConfigSnapshot();
      clearConfigCache();
      server = await startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
      });
      client = await connectGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token,
        clientDisplayName,
        scopes: [ADMIN_SCOPE, READ_SCOPE],
        timeoutMs: 30_000,
      });
    };

    const createdEnvironment = await client.request<{
      id: string;
      status: string;
      worker: { providerId: string; state: string };
    }>("environments.create", {
      profileId: "qa-provider",
      idempotencyKey: "qa-environment-request",
    });
    const replayedEnvironment = await client.request<{ id: string }>("environments.create", {
      profileId: "qa-provider",
      idempotencyKey: "qa-environment-request",
    });
    expect(createdEnvironment).toMatchObject({
      id: "worker-qa-1",
      status: "available",
      worker: { providerId: "qa-provider", state: "ready" },
    });
    expect(replayedEnvironment.id).toBe(createdEnvironment.id);
    expect(injectedWorkerService.createCount()).toBe(1);
    await expect(client.request("environments.list", {})).resolves.toMatchObject({
      environments: expect.arrayContaining([
        expect.objectContaining({ id: createdEnvironment.id, status: "available" }),
      ]),
    });
    await expect(
      client.request("environments.status", { environmentId: createdEnvironment.id }),
    ).resolves.toMatchObject({ id: createdEnvironment.id, status: "available" });
    await expect(
      client.request("environments.destroy", { environmentId: createdEnvironment.id }),
    ).resolves.toMatchObject({
      id: createdEnvironment.id,
      status: "unavailable",
      worker: { state: "destroyed" },
    });

    const createdAgent = await client.request<{
      ok: true;
      agentId: string;
      workspace: string;
    }>("agents.create", {
      name: "Artifact Agent",
      workspace: createdWorkspace,
    });
    expect(createdAgent).toMatchObject({
      ok: true,
      agentId: "artifact-agent",
      workspace: createdWorkspace,
    });
    await restartGateway("gateway agent artifact APIs after create");
    const createdEnvironmentAfterRestart = await client.request<{ id: string }>(
      "environments.create",
      {
        profileId: "qa-provider",
        idempotencyKey: "qa-environment-request-after-restart",
      },
    );
    await expect(client.request("environments.list", {})).resolves.toMatchObject({
      environments: expect.arrayContaining([
        expect.objectContaining({
          id: createdEnvironmentAfterRestart.id,
          status: "available",
        }),
      ]),
    });
    await expect(client.request("agents.list", {})).resolves.toMatchObject({
      agents: expect.arrayContaining([
        expect.objectContaining({
          id: createdAgent.agentId,
          workspace: createdWorkspace,
        }),
      ]),
    });
    await expect(
      client.request("agents.update", {
        agentId: createdAgent.agentId,
        name: "Artifact Steward",
      }),
    ).resolves.toEqual({ ok: true, agentId: createdAgent.agentId });

    const fileContent = "# Artifact steward\n\nOwns durable artifact verification.\n";
    const expectedHash = createHash("sha256").update(fileContent).digest("hex");
    await expect(
      client.request("agents.files.set", {
        agentId: createdAgent.agentId,
        name: "AGENTS.md",
        content: fileContent,
      }),
    ).resolves.toMatchObject({
      ok: true,
      file: { name: "AGENTS.md", content: fileContent, missing: false },
    });
    await expect(
      client.request("agents.files.list", { agentId: createdAgent.agentId }),
    ).resolves.toMatchObject({
      files: expect.arrayContaining([
        expect.objectContaining({
          name: "AGENTS.md",
          missing: false,
          size: Buffer.byteLength(fileContent),
        }),
      ]),
    });
    const fileResult = await client.request<{
      file: { content: string; name: string; missing: boolean };
    }>("agents.files.get", {
      agentId: createdAgent.agentId,
      name: "AGENTS.md",
    });
    expect(fileResult.file).toMatchObject({
      name: "AGENTS.md",
      content: fileContent,
      missing: false,
    });
    expect(createHash("sha256").update(fileResult.file.content).digest("hex")).toBe(expectedHash);

    const sessionKey = "agent:main:artifact-api";
    const sessionId = "gateway-agent-artifact-session";
    const messageId = "gateway-agent-artifact-message";
    const storePath = resolveStorePath(undefined, { agentId: "main" });
    const scope = { agentId: "main", sessionId, sessionKey, storePath };
    await upsertSessionEntry(scope, { sessionId, updatedAt: Date.now() });
    const task = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: sessionKey,
      ownerKey: sessionKey,
      agentId: "main",
      requesterAgentId: "main",
      task: "produce a managed artifact",
      status: "succeeded",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
    });
    if (!task) {
      throw new Error("expected task record");
    }
    cleanup.push(() => {
      deleteTaskRecordById(task.taskId);
    });
    const [managedBlock] = await createManagedOutgoingMediaBlocks({
      sessionKey,
      agentId: "main",
      mediaUrls: [`data:image/png;base64,${TINY_PNG_BASE64}`],
      stateDir,
      messageId,
    });
    expect(managedBlock).toBeDefined();
    await appendTranscriptMessage(scope, {
      eventId: messageId,
      message: {
        role: "assistant",
        content: [managedBlock],
        timestamp: Date.now(),
        __openclaw: {
          id: messageId,
          seq: 1,
          messageTaskId: task.taskId,
        },
      } as never,
    });

    const artifactList = await client.request<{
      artifacts: Array<{
        id: string;
        sessionKey: string;
        taskId?: string;
        download: { mode: string };
      }>;
    }>("artifacts.list", { taskId: task.taskId });
    expect(artifactList.artifacts).toHaveLength(1);
    const artifact = artifactList.artifacts[0]!;
    expect(artifact).toMatchObject({
      sessionKey,
      taskId: task.taskId,
      download: { mode: "url" },
    });
    await expect(
      client.request("artifacts.get", {
        taskId: task.taskId,
        artifactId: artifact.id,
      }),
    ).resolves.toMatchObject({ artifact: { id: artifact.id, taskId: task.taskId } });

    const download = await client.request<{ url: string; expiresAt: string }>(
      "artifacts.download",
      {
        sessionKey,
        artifactId: artifact.id,
      },
    );
    expect(download.url).toContain("mediaTicket=");
    expect(download.expiresAt).toBeTruthy();
    const response = await fetch(`http://127.0.0.1:${port}${download.url}`);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      Buffer.from(TINY_PNG_BASE64, "base64"),
    );

    await expect(
      client.request("artifacts.get", {
        sessionKey,
        artifactId: "artifact_unknown",
      }),
    ).rejects.toThrow(/artifact not found/i);
    await expect(
      client.request("artifacts.get", {
        taskId: task.taskId,
        agentId: "other",
        artifactId: artifact.id,
      }),
    ).rejects.toThrow(/artifact not found/i);

    await expect(
      client.request("agents.delete", {
        agentId: createdAgent.agentId,
        deleteFiles: false,
      }),
    ).resolves.toMatchObject({ ok: true, agentId: createdAgent.agentId });
    await restartGateway("gateway agent artifact APIs after delete");
    const finalAgents = await client.request<{ agents: Array<{ id: string }> }>("agents.list", {});
    expect(finalAgents.agents.map((entry) => entry.id)).not.toContain(createdAgent.agentId);
  }, 120_000);
});
