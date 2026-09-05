import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createQaBusState,
  startQaBusServer,
  createQaGatewayChild,
  type QaGatewayChild,
} from "../../../../extensions/qa-lab/api.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { createQaScriptEvidenceWriter } from "./script-evidence.js";

const SOURCE_PATH = "test/e2e/qa-lab/runtime/gateway-rpc-account-health.ts";
const SCENARIO_PATH = "qa/scenarios/observability/gateway-rpc-account-health.yaml";
const CHANNEL_ID = "qa-channel";
const CHANNEL_LABEL = "QA Channel";
const TARGET_ACCOUNT_ID = "sibling";

type AccountState = {
  accountId?: string;
  configured?: boolean;
  enabled?: boolean;
  running?: boolean;
  stateReason?: string;
};

type GatewayAccountHealthProof = {
  initialHealthOk: boolean;
  initialStatusVisible: boolean;
  initialAccounts: Record<string, AccountState>;
  finalAccounts: Record<string, AccountState>;
  onlyTargetConfigChanged: boolean;
  finalStatusVisible: boolean;
};

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function withSiblingAccount(config: OpenClawConfig, baseUrl?: string): OpenClawConfig {
  const channel = config.channels?.[CHANNEL_ID] as Record<string, unknown> | undefined;
  return {
    ...config,
    channels: {
      ...config.channels,
      [CHANNEL_ID]: {
        ...channel,
        ...(baseUrl && {
          enabled: true,
          baseUrl,
          botUserId: "openclaw",
          botDisplayName: "OpenClaw QA",
          allowFrom: ["*"],
          pollTimeoutMs: 250,
        }),
        accounts: {
          ...(channel?.accounts as Record<string, unknown> | undefined),
          [TARGET_ACCOUNT_ID]: { enabled: true },
        },
      },
    },
  };
}

function assertRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected record, got ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function readHealthAccounts(payload: unknown): Record<string, AccountState> {
  const channels = assertRecord(assertRecord(payload).channels);
  const channel = assertRecord(channels[CHANNEL_ID]);
  const accounts = assertRecord(channel.accounts);
  return Object.fromEntries(
    Object.entries(accounts).map(([accountId, state]) => [
      accountId,
      assertRecord(state) as AccountState,
    ]),
  );
}

function readStatusAccounts(payload: unknown): Record<string, AccountState> {
  const channelAccounts = assertRecord(assertRecord(payload).channelAccounts);
  const accounts = channelAccounts[CHANNEL_ID];
  if (!Array.isArray(accounts)) {
    throw new Error(`channels.status omitted ${CHANNEL_ID} accounts`);
  }
  return Object.fromEntries(
    accounts.map((state) => {
      const record = assertRecord(state) as AccountState;
      return [String(record.accountId), record];
    }),
  );
}

export function statusSummaryMentions(payload: unknown, ...needles: string[]) {
  const channelSummary = assertRecord(payload).channelSummary;
  if (!Array.isArray(channelSummary) || channelSummary.some((line) => typeof line !== "string")) {
    throw new Error(`status omitted channelSummary lines: ${JSON.stringify(payload)}`);
  }
  const text = channelSummary.join("\n").toLowerCase();
  return needles.every((needle) => text.includes(needle.toLowerCase()));
}

async function waitForAccounts(
  gateway: QaGatewayChild,
  predicate: (accounts: Record<string, AccountState>) => boolean,
  label: string,
) {
  const deadline = Date.now() + 30_000;
  let latest: Record<string, AccountState> = {};
  while (Date.now() < deadline) {
    const payload = await gateway.call("channels.status", {
      channel: CHANNEL_ID,
      probe: false,
      timeoutMs: 2_000,
    });
    latest = readStatusAccounts(payload);
    if (predicate(latest)) {
      return latest;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(latest)}`);
}

function readChannelConfig(payload: unknown) {
  const config = assertRecord(assertRecord(payload).config);
  return structuredClone(assertRecord(assertRecord(config.channels)[CHANNEL_ID]));
}

async function waitForAppliedConfig(gateway: QaGatewayChild, hash: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const payload = assertRecord(await gateway.call("config.get", {}));
    if (
      payload.hash === hash &&
      typeof payload.appliedConfigHash === "string" &&
      payload.appliedConfigHash === payload.configRevisionHash
    ) {
      return payload;
    }
    await sleep(100);
  }
  throw new Error("Gateway did not apply patched account config");
}

export async function runGatewayRpcAccountHealthProof(
  repoRoot = path.resolve(import.meta.dirname, "../../../.."),
): Promise<GatewayAccountHealthProof> {
  const state = createQaBusState();
  const bus = await startQaBusServer({ state });
  const gatewayOwner = createQaGatewayChild();
  let gateway: QaGatewayChild | undefined;
  try {
    gateway = await gatewayOwner.start({
      repoRoot,
      useRepoCli: true,
      transportBaseUrl: bus.baseUrl,
      providerMode: "mock-openai",
      controlUiEnabled: false,
      enabledPluginIds: [CHANNEL_ID],
      mutateConfig: (config) => withSiblingAccount(config, bus.baseUrl),
    });
    const initialChannelAccounts = await waitForAccounts(
      gateway,
      (accounts) =>
        accounts.default?.enabled === true &&
        accounts.default.running === true &&
        accounts[TARGET_ACCOUNT_ID]?.enabled === true &&
        accounts[TARGET_ACCOUNT_ID].running === true,
      "both accounts running",
    );
    const initialHealth = await gateway.call("health", { probe: true });
    const initialStatus = await gateway.call("status", { includeChannelSummary: true });
    const initialAccounts = readHealthAccounts(initialHealth);
    const beforeConfig = assertRecord(await gateway.call("config.get", {}));
    const beforeChannelConfig = readChannelConfig(beforeConfig);

    const patchResult = assertRecord(
      await gateway.call("config.patch", {
        raw: JSON.stringify({
          channels: {
            [CHANNEL_ID]: {
              accounts: {
                [TARGET_ACCOUNT_ID]: { enabled: false },
              },
            },
          },
        }),
        baseHash: beforeConfig.hash,
        restartDelayMs: 0,
      }),
    );
    if (typeof patchResult.hash !== "string") {
      throw new Error(`config.patch returned no hash: ${JSON.stringify(patchResult)}`);
    }
    const appliedConfig = await waitForAppliedConfig(gateway, patchResult.hash);
    const afterChannelConfig = readChannelConfig(appliedConfig);
    const expectedChannelConfig = structuredClone(beforeChannelConfig);
    const expectedAccounts = assertRecord(expectedChannelConfig.accounts);
    expectedAccounts[TARGET_ACCOUNT_ID] = {
      ...assertRecord(expectedAccounts[TARGET_ACCOUNT_ID]),
      enabled: false,
    };

    const finalChannelAccounts = await waitForAccounts(
      gateway,
      (accounts) =>
        accounts.default?.enabled === true &&
        accounts.default.running === true &&
        accounts[TARGET_ACCOUNT_ID]?.enabled === false &&
        accounts[TARGET_ACCOUNT_ID].running === false,
      "target disabled and sibling running",
    );
    const finalHealth = await gateway.call("health", { probe: true });
    const finalStatus = await gateway.call("status", { includeChannelSummary: true });
    const finalAccounts = readHealthAccounts(finalHealth);

    return {
      initialHealthOk: assertRecord(initialHealth).ok === true,
      initialStatusVisible:
        statusSummaryMentions(initialStatus, CHANNEL_LABEL, "default", TARGET_ACCOUNT_ID) &&
        initialChannelAccounts.default?.running === true &&
        initialChannelAccounts[TARGET_ACCOUNT_ID]?.running === true,
      initialAccounts,
      finalAccounts,
      onlyTargetConfigChanged:
        JSON.stringify(afterChannelConfig) === JSON.stringify(expectedChannelConfig),
      finalStatusVisible:
        statusSummaryMentions(finalStatus, CHANNEL_LABEL, TARGET_ACCOUNT_ID, "disabled") &&
        finalChannelAccounts.default?.running === true,
    };
  } finally {
    await stopQaGatewayFixture(gatewayOwner).catch(() => undefined);
    await bus.stop().catch(() => undefined);
  }
}

function parseArtifactBase(argv: readonly string[]) {
  const index = argv.indexOf("--artifact-base");
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value) {
    throw new Error("--artifact-base is required");
  }
  return path.resolve(value);
}

export async function main(argv = process.argv.slice(2)) {
  const artifactBase = parseArtifactBase(argv);
  const repoRoot = path.resolve(import.meta.dirname, "../../../..");
  const writer = createQaScriptEvidenceWriter({
    artifactBase,
    logFileName: "gateway-rpc-account-health.log",
    primaryModel: "none",
    providerMode: "mock-openai",
    repoRoot,
    target: {
      id: "gateway-rpc-account-health",
      title: "Gateway RPC account health",
      sourcePath: SCENARIO_PATH,
      docsRefs: ["docs/gateway/health.md", "docs/gateway/protocol.md"],
      codeRefs: [SOURCE_PATH, "src/gateway/server-methods/health.ts"],
    },
  });
  const startedAt = Date.now();
  try {
    const proof = await runGatewayRpcAccountHealthProof(repoRoot);
    const failures = [
      !proof.initialHealthOk && "initial health RPC was not healthy",
      !proof.initialStatusVisible && "initial status did not expose both accounts",
      proof.initialAccounts.default?.running !== true &&
        "default account was not initially running",
      proof.initialAccounts[TARGET_ACCOUNT_ID]?.running !== true &&
        "target account was not initially running",
      !proof.onlyTargetConfigChanged && "config patch changed more than the target account leaf",
      proof.finalAccounts.default?.running !== true && "default sibling stopped after reload",
      proof.finalAccounts[TARGET_ACCOUNT_ID]?.enabled !== false &&
        "target account remained enabled",
      proof.finalAccounts[TARGET_ACCOUNT_ID]?.running !== false &&
        "target account remained running",
      !proof.finalStatusVisible && "disabled target was not operator-visible",
    ].filter((value): value is string => Boolean(value));
    writer.appendLog(`${JSON.stringify(proof, null, 2)}\n`);
    await writer.write({
      status: failures.length === 0 ? "pass" : "fail",
      durationMs: Date.now() - startedAt,
      details:
        failures.length === 0 ? "authenticated account health reload passed" : failures.join("; "),
    });
    if (failures.length > 0) {
      throw new Error(failures.join("; "));
    }
  } catch (error) {
    writer.appendLog(`${error instanceof Error ? error.stack : String(error)}\n`);
    await writer.write({
      status: "fail",
      durationMs: Date.now() - startedAt,
      details: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
