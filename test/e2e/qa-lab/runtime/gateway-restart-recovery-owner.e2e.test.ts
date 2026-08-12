import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { startQaLiveLaneGateway } from "../../../../extensions/qa-lab/runtime-api.js";
import { resolveSessionStorePathCore } from "../../../../src/config/sessions/paths.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../../../../src/config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../../../src/config/sessions/types.js";

type GatewayRunResult = {
  runId?: unknown;
  status?: unknown;
};

type GatewayHandle = Awaited<ReturnType<typeof startQaLiveLaneGateway>>["gateway"];

const AGENT_ID = "qa";
const LOG_WAIT_TIMEOUT_MS = 15_000;
const VERDICT_PATH_ENV = "OPENCLAW_QA_RESTART_RECOVERY_OWNER_VERDICT_PATH";

let harness: Awaited<ReturnType<typeof startQaLiveLaneGateway>> | undefined;

afterEach(async () => {
  await harness?.stop().catch(() => undefined);
  harness = undefined;
});

function sessionStorePath(gateway: GatewayHandle): string {
  return resolveSessionStorePathCore(undefined, {
    agentId: AGENT_ID,
    env: gateway.runtimeEnv,
  });
}

function loadInternalEntry(gateway: GatewayHandle, sessionKey: string): InternalSessionEntry {
  const entry = loadSessionEntry({
    agentId: AGENT_ID,
    readConsistency: "latest",
    sessionKey,
    storePath: sessionStorePath(gateway),
  }) as InternalSessionEntry | undefined;
  if (!entry) {
    throw new Error(`missing QA session entry: ${sessionKey}`);
  }
  return entry;
}

async function replaceInternalEntry(
  gateway: GatewayHandle,
  sessionKey: string,
  patch: Partial<InternalSessionEntry>,
): Promise<void> {
  const nextEntry: InternalSessionEntry = {
    ...loadInternalEntry(gateway, sessionKey),
    ...patch,
  };
  await replaceSessionEntry(
    { agentId: AGENT_ID, sessionKey, storePath: sessionStorePath(gateway) },
    nextEntry,
  );
}

async function runAgent(params: {
  gateway: GatewayHandle;
  message: string;
  restartRecoveryOwner?: "openclaw" | "external";
  sessionKey: string;
}): Promise<GatewayRunResult> {
  const result = (await params.gateway.call(
    "agent",
    {
      message: params.message,
      sessionKey: params.sessionKey,
      deliver: false,
      idempotencyKey: randomUUID(),
      ...(params.restartRecoveryOwner ? { restartRecoveryOwner: params.restartRecoveryOwner } : {}),
    },
    { expectFinal: true, timeoutMs: 90_000 },
  )) as GatewayRunResult;
  expect(result.status).toBe("ok");
  expect(typeof result.runId).toBe("string");
  return result;
}

async function readMockRequestCount(baseUrl: string): Promise<number> {
  const response = await fetch(`${baseUrl}/debug/requests`);
  if (!response.ok) {
    throw new Error(`mock provider request inspection failed: HTTP ${response.status}`);
  }
  const requests: unknown = await response.json();
  if (!Array.isArray(requests)) {
    throw new Error("mock provider request inspection returned a non-array payload");
  }
  return requests.length;
}

async function waitForMockRequestCount(baseUrl: string, expected: number): Promise<number> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < LOG_WAIT_TIMEOUT_MS) {
    const count = await readMockRequestCount(baseUrl);
    if (count >= expected) {
      return count;
    }
    await sleep(100);
  }
  throw new Error(`mock provider request count did not reach ${expected}`);
}

function resolveGatewayFileLogPath(logs: string): string | undefined {
  return [...logs.matchAll(/\[gateway\] log file: (.+)$/gmu)].at(-1)?.[1]?.trim();
}

function hasStructuredSkipLog(
  logs: string,
  sessionKey: string,
  phase: "mark" | "dispatch",
): boolean {
  return logs.split("\n").some((line) => {
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      const fields = record["1"];
      return (
        record["2"] === "skipping main-session restart recovery" &&
        typeof fields === "object" &&
        fields !== null &&
        (fields as Record<string, unknown>).phase === phase &&
        (fields as Record<string, unknown>).reason === "external_owner" &&
        (fields as Record<string, unknown>).sessionKey === sessionKey
      );
    } catch {
      return false;
    }
  });
}

async function waitForStructuredSkipLog(
  gateway: GatewayHandle,
  sessionKey: string,
  phase: "mark" | "dispatch",
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < LOG_WAIT_TIMEOUT_MS) {
    const logPath = resolveGatewayFileLogPath(gateway.logs());
    if (logPath) {
      const fileLogs = await fs.readFile(logPath, "utf8").catch(() => "");
      if (hasStructuredSkipLog(fileLogs, sessionKey, phase)) {
        return;
      }
    }
    await sleep(100);
  }
  throw new Error(`missing structured external-owner ${phase} log:\n${gateway.logs()}`);
}

async function writeVerdict(verdict: Record<string, unknown>): Promise<void> {
  const outputPath = process.env[VERDICT_PATH_ENV]?.trim();
  if (outputPath) {
    const resolvedPath = path.resolve(outputPath);
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fs.writeFile(resolvedPath, `${JSON.stringify(verdict, null, 2)}\n`, "utf8");
  }
  console.info(`[restart-recovery-owner-verdict] ${JSON.stringify(verdict)}`);
}

describe("Gateway external restart recovery owner", () => {
  it(
    "skips external recovery, resets ownership on rotation, and transfers quarantine",
    { timeout: 180_000 },
    async () => {
      harness = await startQaLiveLaneGateway({
        repoRoot: process.cwd(),
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        alternateModel: "mock-openai/gpt-5.6-luna-alt",
        transport: {
          requiredPluginIds: [],
          createGatewayConfig: () => ({}),
        },
        transportBaseUrl: "http://127.0.0.1",
        controlUiEnabled: false,
      });
      const { gateway, mock } = harness;
      if (!mock) {
        throw new Error("expected the managed mock OpenAI provider");
      }

      const sessionKey = `agent:${AGENT_ID}:restart-recovery-owner-${randomUUID()}`;
      await runAgent({
        gateway,
        sessionKey,
        restartRecoveryOwner: "external",
        message: "Gateway owner QA. Reply exactly `EXTERNAL_OWNER_READY`.",
      });
      expect(loadInternalEntry(gateway, sessionKey).restartRecoveryOwner).toBe("external");
      const requestsBeforeExternalRestarts = await readMockRequestCount(mock.baseUrl);

      await gateway.restartAfterStateMutation(async () => {
        await replaceInternalEntry(gateway, sessionKey, {
          abortedLastRun: false,
          mainRestartRecovery: undefined,
          restartRecoveryRuns: undefined,
          status: "running",
        });
      });
      await waitForStructuredSkipLog(gateway, sessionKey, "mark");
      expect(await readMockRequestCount(mock.baseUrl)).toBe(requestsBeforeExternalRestarts);
      expect(loadInternalEntry(gateway, sessionKey)).toMatchObject({
        abortedLastRun: false,
        restartRecoveryOwner: "external",
        status: "running",
      });

      await gateway.restartAfterStateMutation(async () => {
        await replaceInternalEntry(gateway, sessionKey, {
          abortedLastRun: true,
          mainRestartRecovery: {
            chargedAttempts: 1,
            cycleId: "qa-external-owner-cycle",
            revision: 2,
          },
          restartRecoveryRuns: [
            { lifecycleGeneration: "qa-external-generation", runId: "qa-external-run" },
          ],
          status: "running",
        });
      });
      await waitForStructuredSkipLog(gateway, sessionKey, "dispatch");
      await sleep(500);
      const requestsAfterExternalRestarts = await readMockRequestCount(mock.baseUrl);
      expect(requestsAfterExternalRestarts).toBe(requestsBeforeExternalRestarts);
      expect(loadInternalEntry(gateway, sessionKey)).toMatchObject({
        abortedLastRun: true,
        restartRecoveryOwner: "external",
        status: "running",
      });

      const externalSessionId = loadInternalEntry(gateway, sessionKey).sessionId;
      if (!externalSessionId) {
        throw new Error("expected the externally owned session generation");
      }
      await gateway.restartAfterStateMutation(async () => {
        await replaceInternalEntry(gateway, sessionKey, {
          abortedLastRun: false,
          mainRestartRecovery: undefined,
          restartRecoveryRuns: undefined,
          status: undefined,
          updatedAt: 0,
        });
      });
      await runAgent({
        gateway,
        sessionKey,
        message: "Gateway generation rotation QA. Reply exactly `ROTATED_TO_OPENCLAW`.",
      });
      const rotated = loadInternalEntry(gateway, sessionKey);
      expect(rotated.sessionId).toEqual(expect.any(String));
      expect(rotated.sessionId).not.toBe(externalSessionId);
      expect(rotated.restartRecoveryOwner).toBeUndefined();
      const requestsAfterRotation = await readMockRequestCount(mock.baseUrl);
      expect(requestsAfterRotation).toBe(requestsAfterExternalRestarts + 1);

      await gateway.restartAfterStateMutation(async () => {
        await replaceInternalEntry(gateway, sessionKey, {
          abortedLastRun: false,
          mainRestartRecovery: undefined,
          restartRecoveryRuns: undefined,
          status: "running",
        });
      });
      const requestsAfterRotatedRecovery = await waitForMockRequestCount(
        mock.baseUrl,
        requestsAfterRotation + 1,
      );
      expect(requestsAfterRotatedRecovery).toBe(requestsAfterRotation + 1);
      expect(loadInternalEntry(gateway, sessionKey).restartRecoveryOwner).toBeUndefined();
      await sleep(500);

      await gateway.restartAfterStateMutation(async () => {
        await replaceInternalEntry(gateway, sessionKey, {
          abortedLastRun: false,
          mainRestartRecovery: {
            chargedAttempts: 3,
            cycleId: "qa-tombstoned-owner-cycle",
            revision: 4,
            tombstone: { reason: "automatic recovery exhausted" },
          },
          restartRecoveryOwner: undefined,
          restartRecoveryRuns: undefined,
          status: "failed",
        });
      });
      await runAgent({
        gateway,
        sessionKey,
        restartRecoveryOwner: "external",
        message: "Gateway quarantine transfer QA. Reply exactly `QUARANTINE_TRANSFERRED`.",
      });
      const transferred = loadInternalEntry(gateway, sessionKey);
      expect(transferred.restartRecoveryOwner).toBe("external");
      expect(transferred.abortedLastRun).toBe(false);
      expect(transferred.mainRestartRecovery).toBeUndefined();
      expect(transferred.restartRecoveryRuns).toBeUndefined();

      const requestsAfterTransfer = await readMockRequestCount(mock.baseUrl);
      expect(requestsAfterTransfer).toBe(requestsAfterRotatedRecovery + 1);
      await writeVerdict({
        schemaVersion: 1,
        scenario: "gateway-external-restart-recovery-owner",
        gatewayBoundary: "child-process-websocket-rpc",
        providerMode: "mock-openai",
        assertions: {
          ownerPersisted: transferred.restartRecoveryOwner === "external",
          restartSkipPhases: ["mark", "dispatch"],
          providerCallsDuringExternalRestarts:
            requestsAfterExternalRestarts - requestsBeforeExternalRestarts,
          rotatedGenerationOwnerCleared: rotated.restartRecoveryOwner === undefined,
          providerCallsForRotatedRecovery: requestsAfterRotatedRecovery - requestsAfterRotation,
          quarantinedTransferClearedRecovery:
            transferred.abortedLastRun === false &&
            transferred.mainRestartRecovery === undefined &&
            transferred.restartRecoveryRuns === undefined,
          providerCallsForTransfer: requestsAfterTransfer - requestsAfterRotatedRecovery,
        },
        pass: true,
      });
    },
  );
});
