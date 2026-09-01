import { X509Certificate } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../src/config/config.js";
import { resetConfigOverrides } from "../src/config/runtime-overrides.js";
import { clearSessionStoreCacheForTest } from "../src/config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { GatewayClient } from "../src/gateway/client.js";
import { startGatewayServer } from "../src/gateway/server.js";
import {
  disconnectGatewayClient,
  getGatewayE2ePortBlock,
} from "../src/gateway/test-helpers.e2e.js";
import { ensureProfileForEmail, setUserProfileRole } from "../src/state/user-profiles.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../src/test-utils/env.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../src/utils/message-channel.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../test/helpers/tls-fixture.js";

const ISOLATED_ENV_KEYS = [
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_GATEWAY_PASSWORD",
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
  snapshotRevision: string;
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset: number | null;
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
  if (
    !Array.isArray(result.jobs) ||
    typeof result.snapshotRevision !== "string" ||
    typeof result.total !== "number" ||
    typeof result.offset !== "number" ||
    typeof result.limit !== "number" ||
    typeof result.hasMore !== "boolean" ||
    (result.nextOffset !== null && typeof result.nextOffset !== "number")
  ) {
    throw new Error(`${label} was not a complete cron list page`);
  }
  return result as unknown as CronListResult;
}

function summarizeList(result: CronListResult) {
  return {
    total: result.total,
    snapshotRevision: result.snapshotRevision,
    offset: result.offset,
    limit: result.limit,
    hasMore: result.hasMore,
    nextOffset: result.nextOffset,
    returnedJobIds: result.jobs.map((job) => job.id),
    returnedJobNames: result.jobs.map((job) => job.name),
    ...(result.visibility ? { visibility: result.visibility } : {}),
  };
}

async function connectTrustedProxyClient(params: {
  url: string;
  user: string;
  tlsFingerprint: string;
  clientDisplayName: string;
}): Promise<GatewayClient> {
  return await new Promise<GatewayClient>((resolve, reject) => {
    let settled = false;
    let client: GatewayClient | undefined;
    let timer: NodeJS.Timeout | undefined;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (error) {
        void client?.stopAndWait({ timeoutMs: 1_000 }).catch(() => {
          client?.stop();
        });
        reject(error);
        return;
      }
      resolve(client as GatewayClient);
    };

    client = new GatewayClient({
      url: params.url,
      edgeAuthHeaders: {
        "x-forwarded-user": params.user,
        "x-forwarded-for": "198.51.100.42",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "gateway.proof.test",
      },
      tlsFingerprint: params.tlsFingerprint,
      deviceIdentity: null,
      clientName: GATEWAY_CLIENT_NAMES.TEST,
      clientDisplayName: params.clientDisplayName,
      clientVersion: "dev",
      platform: "test",
      mode: GATEWAY_CLIENT_MODES.TEST,
      role: "operator",
      scopes: ["operator.read", "operator.write"],
      onHelloOk: () => finish(),
      onConnectError: (error) => finish(error),
      onClose: (code, reason) =>
        finish(new Error(`gateway closed during trusted-proxy connect (${code}): ${reason}`)),
    });
    timer = setTimeout(() => finish(new Error("trusted-proxy gateway connect timeout")), 10_000);
    timer.unref();
    client.start();
  });
}

async function main(): Promise<void> {
  const outputPath = readOutputPath();
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "openclaw-cron-role-live-proof-"));
  const stateDir = path.join(tempHome, ".openclaw");
  const workspaceDir = path.join(tempHome, "workspace");
  const bundledPluginsDir = path.join(tempHome, "empty-bundled-plugins");
  const configPath = path.join(stateDir, "openclaw.json");
  const certPath = path.join(tempHome, "gateway-cert.pem");
  const keyPath = path.join(tempHome, "gateway-key.pem");
  await Promise.all([
    mkdir(workspaceDir, { recursive: true }),
    mkdir(bundledPluginsDir, { recursive: true }),
    mkdir(path.dirname(configPath), { recursive: true }),
    writeFile(certPath, TEST_TLS_CERT_PEM, { mode: 0o600 }),
    writeFile(keyPath, TEST_TLS_KEY_PEM, { mode: 0o600 }),
  ]);

  const port = await getGatewayE2ePortBlock();
  const ownerEmail = "cron-role-owner@example.test";
  const limitedEmail = "cron-role-limited@example.test";
  const limitedSessionKey = "agent:ops:live-role-limited";
  const ownerSessionKey = "agent:ops:live-role-owner";
  const visibleName = "live-role-visible";
  const hiddenName = "live-role-hidden";
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
      auth: {
        mode: "trusted-proxy",
        trustedProxy: {
          userHeader: "x-forwarded-user",
          allowLoopback: true,
        },
        identityScopes: {
          [ownerEmail]: ["operator.admin", "operator.read", "operator.write"],
          [limitedEmail]: ["operator.read", "operator.write"],
        },
      },
      trustedProxies: ["127.0.0.1"],
      tls: {
        enabled: true,
        autoGenerate: false,
        certPath,
        keyPath,
      },
      roles: {
        default: "limited",
        definitions: {
          limited: {
            sessions: { others: "none" },
            agents: "*",
            scopes: ["operator.read", "operator.write"],
          },
          owner: {
            sessions: { others: "write" },
            agents: "*",
            scopes: ["operator.admin", "operator.read", "operator.write"],
          },
        },
      },
    },
    plugins: { slots: { memory: "none" } },
  } satisfies OpenClawConfig;
  const envSnapshot = captureEnv([...ISOLATED_ENV_KEYS]);
  let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
  let ownerClient: GatewayClient | undefined;
  let limitedClient: GatewayClient | undefined;

  try {
    for (const [key, value] of Object.entries({
      HOME: tempHome,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
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
    deleteTestEnvValue("OPENCLAW_GATEWAY_TOKEN");
    deleteTestEnvValue("OPENCLAW_GATEWAY_PASSWORD");
    deleteTestEnvValue("OPENCLAW_GATEWAY_URL");
    deleteTestEnvValue("OPENCLAW_TEST_MINIMAL_GATEWAY");
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    resetConfigOverrides();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    clearSessionStoreCacheForTest();

    const ownerProfile = ensureProfileForEmail(ownerEmail);
    const limitedProfile = ensureProfileForEmail(limitedEmail);
    setUserProfileRole(ownerProfile.id, "owner");
    setUserProfileRole(limitedProfile.id, "limited");

    server = await startGatewayServer(port, {
      bind: "loopback",
      controlUiEnabled: false,
    });
    await server.startupSettled;
    const tlsFingerprint = new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256;
    ownerClient = await connectTrustedProxyClient({
      url: `wss://127.0.0.1:${port}`,
      user: ownerEmail,
      tlsFingerprint,
      clientDisplayName: "cron-role-proof-owner",
    });
    limitedClient = await connectTrustedProxyClient({
      url: `wss://127.0.0.1:${port}`,
      user: limitedEmail,
      tlsFingerprint,
      clientDisplayName: "cron-role-proof-limited",
    });

    const limitedSession = await limitedClient.request<{ key?: string }>("sessions.create", {
      key: limitedSessionKey,
      agentId: "ops",
    });
    const ownerSession = await ownerClient.request<{ key?: string }>("sessions.create", {
      key: ownerSessionKey,
      agentId: "ops",
    });
    if (limitedSession.key !== limitedSessionKey || ownerSession.key !== ownerSessionKey) {
      throw new Error(
        `session creation returned unexpected keys: ${JSON.stringify({ limitedSession, ownerSession })}`,
      );
    }

    const schedule = {
      kind: "at" as const,
      at: new Date(Date.now() + 3_600_000).toISOString(),
    };
    const visible = await ownerClient.request<{ id: string }>("cron.add", {
      name: visibleName,
      owner: { agentId: "ops", sessionKey: limitedSessionKey, accountId: "default" },
      agentId: "ops",
      sessionKey: limitedSessionKey,
      schedule,
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "live limited-role visibility proof" },
      delivery: { mode: "none" },
    });
    const hidden = await ownerClient.request<{ id: string }>("cron.add", {
      name: hiddenName,
      owner: { agentId: "ops", sessionKey: ownerSessionKey, accountId: "default" },
      agentId: "ops",
      sessionKey: ownerSessionKey,
      schedule,
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "live hidden role inventory" },
      delivery: { mode: "none" },
    });

    const ownerBefore = readCronListResult(
      await ownerClient.request("cron.list", { includeDisabled: true, compact: true, limit: 200 }),
      "owner cron.list before limited-role call",
    );
    if (
      !ownerBefore.jobs.some((job) => job.id === visible.id) ||
      !ownerBefore.jobs.some((job) => job.id === hidden.id)
    ) {
      throw new Error(
        `owner inventory was not complete: ${JSON.stringify(summarizeList(ownerBefore))}`,
      );
    }

    const limitedInventory = readCronListResult(
      await limitedClient.request("cron.list", {
        includeDisabled: true,
        compact: true,
        limit: 200,
      }),
      "limited-role cron.list inventory",
    );
    const limitedPage = readCronListResult(
      await limitedClient.request("cron.list", {
        includeDisabled: true,
        compact: true,
        limit: 1,
      }),
      "limited-role cron.list paged view",
    );
    const ownerAfter = readCronListResult(
      await ownerClient.request("cron.list", { includeDisabled: true, compact: true, limit: 200 }),
      "owner cron.list after limited-role call",
    );
    const warning = limitedInventory.visibility?.warning ?? "";
    const pageMetadataConsistent =
      limitedPage.total === limitedInventory.total &&
      limitedPage.snapshotRevision === limitedInventory.snapshotRevision &&
      limitedPage.offset === 0 &&
      limitedPage.limit === 1 &&
      limitedPage.jobs.length <= 1 &&
      limitedPage.nextOffset === (limitedPage.hasMore ? limitedPage.jobs.length : null);
    if (
      limitedInventory.total >= ownerBefore.total ||
      !limitedInventory.jobs.some((job) => job.id === visible.id) ||
      limitedInventory.jobs.some((job) => job.id === hidden.id) ||
      limitedInventory.visibility?.mode !== "role" ||
      !limitedInventory.visibility.restricted ||
      !warning.includes("total, pagination, and snapshotRevision describe this restricted view") ||
      !pageMetadataConsistent ||
      ownerAfter.total !== ownerBefore.total ||
      !ownerAfter.jobs.some((job) => job.id === visible.id) ||
      !ownerAfter.jobs.some((job) => job.id === hidden.id)
    ) {
      throw new Error(
        `live limited-role assertion failed: ${JSON.stringify({
          ownerBefore: summarizeList(ownerBefore),
          limitedInventory: summarizeList(limitedInventory),
          limitedPage: summarizeList(limitedPage),
          ownerAfter: summarizeList(ownerAfter),
        })}`,
      );
    }

    const proof = {
      kind: "real-gateway-trusted-proxy-role",
      transport: {
        gatewayServer: "startGatewayServer",
        ownerClient: "GatewayClient over wss://127.0.0.1 with TLS pin and x-forwarded-user",
        limitedClient: "GatewayClient over wss://127.0.0.1 with TLS pin and x-forwarded-user",
        authMode: "trusted-proxy",
        trustedProxy: "127.0.0.1",
        tlsFingerprint: "omitted from durable proof",
      },
      roles: {
        owner: { user: ownerEmail, sessionsOthers: "write" },
        limited: { user: limitedEmail, sessionsOthers: "none" },
      },
      sessions: {
        limited: { key: limitedSessionKey, createdBy: limitedEmail },
        owner: { key: ownerSessionKey, createdBy: ownerEmail },
      },
      seededJobs: {
        visible: { id: visible.id, name: visibleName, ownerSessionKey: limitedSessionKey },
        hidden: { id: hidden.id, name: hiddenName, ownerSessionKey: ownerSessionKey },
      },
      owner: {
        beforeLimitedRoleCall: summarizeList(ownerBefore),
        afterLimitedRoleCall: summarizeList(ownerAfter),
        inventoryStable:
          ownerAfter.total === ownerBefore.total &&
          ownerAfter.jobs.some((job) => job.id === visible.id) &&
          ownerAfter.jobs.some((job) => job.id === hidden.id),
      },
      limitedRole: {
        inventory: summarizeList(limitedInventory),
        pagedView: summarizeList(limitedPage),
        visibleJobPresent: limitedInventory.jobs.some((job) => job.id === visible.id),
        hiddenJobRedacted: !limitedInventory.jobs.some((job) => job.id === hidden.id),
        restrictedMarkerPresent:
          limitedInventory.visibility?.mode === "role" && limitedInventory.visibility.restricted,
        filteredRevisionPresent: limitedInventory.snapshotRevision !== ownerBefore.snapshotRevision,
        paginationMetadataConsistent: pageMetadataConsistent,
      },
      assertions: {
        limitedRoleSeesFewerJobs: limitedInventory.total < ownerBefore.total,
        limitedRoleSeesOwnSessionJob: limitedInventory.jobs.some((job) => job.id === visible.id),
        limitedRoleHidesForeignSessionJob: !limitedInventory.jobs.some(
          (job) => job.id === hidden.id,
        ),
        restrictedMarkerPresent:
          limitedInventory.visibility?.mode === "role" && limitedInventory.visibility.restricted,
        filteredSnapshotRevision:
          limitedInventory.snapshotRevision !== ownerBefore.snapshotRevision,
        filteredPaginationMetadata: pageMetadataConsistent,
      },
    };
    const serialized = `${JSON.stringify(proof, null, 2)}\n`;
    if (outputPath) {
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, serialized);
    }
    console.log(serialized);
  } finally {
    if (limitedClient) {
      await disconnectGatewayClient(limitedClient).catch(() => undefined);
    }
    if (ownerClient) {
      await disconnectGatewayClient(ownerClient).catch(() => undefined);
    }
    if (server) {
      await server
        .close({ reason: "live cron limited-role proof complete" })
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
