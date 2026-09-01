import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCronTool } from "../src/agents/tools/cron-tool.js";
import { withGatewayToolCallerIdentity } from "../src/agents/tools/gateway-caller-context.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
} from "../src/config/config.js";
import { resetConfigOverrides } from "../src/config/runtime-overrides.js";
import { clearSessionStoreCacheForTest } from "../src/config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { startGatewayServer } from "../src/gateway/server.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  getGatewayE2ePortBlock,
} from "../src/gateway/test-helpers.e2e.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../src/infra/agent-run-registry.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../src/test-utils/env.js";

const ISOLATED_ENV_KEYS = [
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_GATEWAY_PORT",
  "OPENCLAW_GATEWAY_URL",
  "OPENCLAW_TEST_GATEWAY_OVERRIDE_TOKEN",
  "OPENCLAW_TEST_RUNTIME_OVERRIDE_TOKEN",
  "OPENCLAW_TEST_MINIMAL_GATEWAY",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
] as const;

type CronListJob = {
  id: string;
  name?: string;
};

type CronVisibility = {
  mode?: string;
  restricted?: boolean;
  warning?: string;
};

type CronListResult = {
  jobs: CronListJob[];
  total: number;
  visibility?: CronVisibility;
};

function readOutputPath(): string | undefined {
  const index = process.argv.indexOf("--output");
  if (index < 0) {
    return undefined;
  }
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("--output requires a file path");
  }
  return path.resolve(value);
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} was not an object`);
  }
  return value as Record<string, unknown>;
}

function readCronListResult(value: unknown, label: string): CronListResult {
  const result = assertRecord(value, label);
  if (!Array.isArray(result.jobs) || typeof result.total !== "number") {
    throw new Error(`${label} was not a cron list page`);
  }
  return result as unknown as CronListResult;
}

function summarizeList(result: CronListResult) {
  return {
    total: result.total,
    returnedJobIds: result.jobs.map((job) => job.id),
    returnedJobNames: result.jobs.map((job) => job.name),
    ...(result.visibility ? { visibility: result.visibility } : {}),
  };
}

async function main(): Promise<void> {
  const outputPath = readOutputPath();
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "openclaw-cron-live-proof-"));
  const stateDir = path.join(tempHome, ".openclaw");
  const workspaceDir = path.join(tempHome, "workspace");
  const bundledPluginsDir = path.join(tempHome, "empty-bundled-plugins");
  const configPath = path.join(stateDir, "openclaw.json");
  await Promise.all([
    mkdir(workspaceDir, { recursive: true }),
    mkdir(bundledPluginsDir, { recursive: true }),
    mkdir(path.dirname(configPath), { recursive: true }),
  ]);

  const token = `cron-live-proof-${process.pid}-${randomUUID()}`;
  const port = await getGatewayE2ePortBlock();
  const sessionKey = "agent:ops:main";
  const visibleName = "live-proof-visible-ops";
  const hiddenName = "live-proof-hidden-worker";
  const config = {
    agents: {
      defaults: {
        workspace: workspaceDir,
        skipBootstrap: true,
        heartbeat: { every: "1h", target: "none" },
      },
      entries: {
        ops: { default: true },
        worker: {},
      },
    },
    gateway: {
      port,
      auth: { mode: "token", token },
    },
    plugins: { slots: { memory: "none" } },
  } satisfies OpenClawConfig;
  const envSnapshot = captureEnv([...ISOLATED_ENV_KEYS]);
  let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
  let operatorClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
  let delegatedAuthority: ReturnType<typeof claimAgentRunDelegatedAuthority> | undefined;
  const operationalRunInstance = Object.freeze({
    instanceId: `cron-live-proof-${process.pid}`,
    runId: `cron-live-proof-run-${randomUUID()}`,
  });

  try {
    for (const [key, value] of Object.entries({
      HOME: tempHome,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_GATEWAY_TOKEN: token,
      OPENCLAW_GATEWAY_PORT: String(port),
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "0",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    })) {
      setTestEnvValue(key, value);
    }
    deleteTestEnvValue("OPENCLAW_GATEWAY_URL");
    deleteTestEnvValue("OPENCLAW_TEST_MINIMAL_GATEWAY");
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    resetConfigOverrides();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    clearSessionStoreCacheForTest();

    server = await startGatewayServer(port, {
      bind: "loopback",
      auth: { mode: "token", token },
      controlUiEnabled: false,
    });
    operatorClient = await connectGatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token,
      clientDisplayName: "cron-live-proof-operator",
    });

    const schedule = {
      kind: "at" as const,
      at: new Date(Date.now() + 3_600_000).toISOString(),
    };
    const owner = { agentId: "ops", sessionKey, accountId: "default" };
    const visible = await operatorClient.request<{ id: string }>("cron.add", {
      name: visibleName,
      owner,
      agentId: "ops",
      sessionKey,
      schedule,
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "live caller-scope proof" },
      delivery: { mode: "none" },
    });
    const hidden = await operatorClient.request<{ id: string }>("cron.add", {
      name: hiddenName,
      owner: { agentId: "worker", sessionKey: "agent:worker:main", accountId: "default" },
      agentId: "worker",
      sessionKey: "agent:worker:main",
      schedule,
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "live hidden control" },
      delivery: { mode: "none" },
    });

    const operatorBefore = readCronListResult(
      await operatorClient.request("cron.list", { includeDisabled: true, compact: true }),
      "operator cron.list before agent call",
    );
    const operatorHasSeededJobs =
      operatorBefore.jobs.some((job) => job.id === visible.id) &&
      operatorBefore.jobs.some((job) => job.id === hidden.id);
    if (!operatorHasSeededJobs) {
      throw new Error(
        `operator inventory was not complete: ${JSON.stringify(summarizeList(operatorBefore))}`,
      );
    }

    delegatedAuthority = claimAgentRunDelegatedAuthority(operationalRunInstance);
    const runtimeConfig = getRuntimeConfig();
    const automations = createCronTool({
      agentId: "ops",
      agentSessionKey: sessionKey,
      agentAccountId: "default",
      config: runtimeConfig,
    });
    const toolResult = await withGatewayToolCallerIdentity(
      {
        agentId: "ops",
        sessionKey,
        operationalRunInstance,
        turnSourceLocal: true,
        turnSourceAccountId: "default",
      },
      () =>
        automations.execute("cron-live-proof-tool-call", { action: "list", includeDisabled: true }),
    );
    const agentResult = readCronListResult(toolResult.details, "agent Automations cron.list");
    const operatorAfter = readCronListResult(
      await operatorClient.request("cron.list", { includeDisabled: true, compact: true }),
      "operator cron.list after agent call",
    );
    if (
      agentResult.total < 1 ||
      !agentResult.jobs.some((job) => job.id === visible.id) ||
      agentResult.jobs.some((job) => job.id === hidden.id) ||
      agentResult.visibility?.mode !== "caller" ||
      !agentResult.visibility.restricted ||
      !agentResult.visibility.warning ||
      operatorAfter.total !== operatorBefore.total ||
      !operatorAfter.jobs.some((job) => job.id === visible.id) ||
      !operatorAfter.jobs.some((job) => job.id === hidden.id)
    ) {
      throw new Error(
        `live caller-scope assertion failed: ${JSON.stringify({
          operatorAfter: summarizeList(operatorAfter),
          agent: summarizeList(agentResult),
        })}`,
      );
    }

    const proof = {
      kind: "real-gateway-agent-session",
      transport: {
        gatewayServer: "startGatewayServer",
        operatorClient: "GatewayClient over ws://127.0.0.1",
        agentToolClient: "callGatewayTool over ws://127.0.0.1",
      },
      seededJobs: {
        visible: { id: visible.id, name: visibleName, ownerAgentId: "ops" },
        hidden: { id: hidden.id, name: hiddenName, ownerAgentId: "worker" },
      },
      operator: {
        beforeAgentCall: summarizeList(operatorBefore),
        afterAgentCall: summarizeList(operatorAfter),
        inventoryComplete:
          operatorAfter.total === operatorBefore.total &&
          operatorAfter.jobs.some((job) => job.id === visible.id) &&
          operatorAfter.jobs.some((job) => job.id === hidden.id),
      },
      agentSession: {
        tool: automations.name,
        clientDisplayName: "agent",
        agentId: "ops",
        sessionKey,
        turnSource: "local",
        runtimeIdentityToken: "minted by callGatewayTool; token omitted",
        result: summarizeList(agentResult),
        callerOwnedSeededJobVisible: agentResult.jobs.some((job) => job.id === visible.id),
        hiddenJobRedacted: !agentResult.jobs.some((job) => job.id === hidden.id),
      },
      assertions: {
        operatorSeesBothJobs:
          operatorAfter.total === operatorBefore.total &&
          operatorAfter.jobs.some((job) => job.id === visible.id) &&
          operatorAfter.jobs.some((job) => job.id === hidden.id),
        agentSeesCallerOwnedSeededJob: agentResult.jobs.some((job) => job.id === visible.id),
        restrictedMarkerPresent:
          agentResult.visibility?.mode === "caller" && agentResult.visibility.restricted,
        hiddenWorkerJobRedacted: !agentResult.jobs.some((job) => job.id === hidden.id),
      },
    };
    const serialized = `${JSON.stringify(proof, null, 2)}\n`;
    if (outputPath) {
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, serialized);
    }
    console.log(serialized);
  } finally {
    if (delegatedAuthority) {
      releaseAgentRunDelegatedAuthority(delegatedAuthority);
    }
    if (operatorClient) {
      await disconnectGatewayClient(operatorClient).catch(() => undefined);
    }
    if (server) {
      await server
        .close({ reason: "live cron caller-scope proof complete" })
        .catch(() => undefined);
    }
    envSnapshot.restore();
    resetConfigOverrides();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    clearSessionStoreCacheForTest();
    await rm(tempHome, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
