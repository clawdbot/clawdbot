import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { resolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway, isGatewayTransportError } from "../gateway/call.js";
import { createConfiguredGatewayLocalProbe } from "../gateway/local-http-probe.js";
import { READ_SCOPE, WRITE_SCOPE } from "../gateway/method-scopes.js";
import { resolveGatewayProbeAuthSafeWithSecretInputs } from "../gateway/probe-auth.js";
import { racePromiseWithAbortSignal } from "./abort-signal.js";
import { readUpdateServingTranscript } from "./update-serving-verification-readback.js";
import {
  UpdateServingGatewayIdentitySchema,
  UpdateServingReceiptSchema,
  type UpdateServingGatewayIdentity,
  type UpdateServingVerificationResult,
} from "./update-serving-verification-receipt.js";

export type { UpdateServingVerificationResult } from "./update-serving-verification-receipt.js";

export type VerifyUpdateServingParams = {
  runId: string;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  gatewayPort: number;
  expectedVersion: string;
  /** Null explicitly means the artifact has no build ID. Undefined does not waive version binding. */
  expectedBuildId?: string | null;
  expectedBootId?: string;
  agentId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

/**
 * One normal Gateway agent turn using configured provider selection, followed by
 * fresh canonical persistence readback. Does not finalize, retain, or write a ledger.
 * A result is evidence for this boot only, never reusable across a later restart.
 */
export async function verifyUpdateServing(
  params: VerifyUpdateServingParams,
): Promise<UpdateServingVerificationResult> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(params.runId) ||
    !params.expectedVersion ||
    !Number.isInteger(params.gatewayPort) ||
    params.gatewayPort < 1 ||
    params.gatewayPort > 65535
  ) {
    return { status: "failed", reason: "invalid-request" };
  }
  const timeoutMs = params.timeoutMs ?? 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    return { status: "failed", reason: "invalid-request" };
  }
  const deadlineAt = Date.now() + timeoutMs;
  const deadline = new AbortController();
  const invalidated = new AbortController();
  const signal = AbortSignal.any([
    deadline.signal,
    invalidated.signal,
    ...(params.signal ? [params.signal] : []),
  ]);
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  let identityFailure: UpdateServingVerificationResult | undefined;
  let stage: "agent" | "gateway" | "persistence" = "agent";
  let acceptedRun = false;
  try {
    signal.throwIfAborted();
    const agentId = resolveAmbientOwnerAgentId(params.config, params.agentId);
    const agentRunId = randomUUID();
    const sessionKey = `agent:${agentId}:update-verification:${agentRunId}`;
    const response = `update-verified-${agentRunId}`;
    const prompt = `This is an OpenClaw update serving check. Do not use tools. Reply with exactly: ${response}`;
    stage = "gateway";
    const [credentials, target] = await racePromiseWithAbortSignal(
      Promise.all([
        resolveGatewayProbeAuthSafeWithSecretInputs({
          cfg: params.config,
          mode: "local",
          env: params.env,
        }),
        createConfiguredGatewayLocalProbe(params.config).resolveWebSocketTarget(params.gatewayPort),
      ]),
      signal,
    );
    if (!target) {
      return { status: "unavailable", reason: "gateway-unavailable" };
    }
    const authNone = params.config.gateway?.auth?.mode === "none";
    let gateway: UpdateServingGatewayIdentity | undefined;
    const connection = {
      config: params.config,
      localPortOverride: params.gatewayPort,
      token: credentials.auth?.token,
      password: credentials.auth?.password,
      skipImplicitAuth: true,
      tlsFingerprint: target.tlsFingerprint,
      clientName: authNone ? GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT : GATEWAY_CLIENT_NAMES.CLI,
      mode: authNone ? GATEWAY_CLIENT_MODES.BACKEND : GATEWAY_CLIENT_MODES.CLI,
      requireLocalBackendSharedAuth: authNone,
      deviceIdentity: null,
      sharedStateMode: "read-only" as const,
      signal,
    };
    const inspectHello: NonNullable<Parameters<typeof callGateway>[0]["onHelloOk"]> = (hello) => {
      const parsed = UpdateServingGatewayIdentitySchema.safeParse({
        bootId: hello.server.bootId,
        version: hello.server.version,
        buildId: hello.server.buildId ?? null,
      });
      if (!parsed.success) {
        identityFailure = { status: "unavailable", reason: "identity-unavailable" };
      } else if (gateway && !isDeepStrictEqual(gateway, parsed.data)) {
        identityFailure = { status: "failed", reason: "runtime-changed" };
      } else if (
        parsed.data.version !== params.expectedVersion ||
        (params.expectedBuildId !== undefined && parsed.data.buildId !== params.expectedBuildId) ||
        (params.expectedBootId !== undefined && parsed.data.bootId !== params.expectedBootId)
      ) {
        identityFailure = { status: "failed", reason: "runtime-mismatch" };
      } else {
        gateway = parsed.data;
        return;
      }
      // callGateway invokes this observer synchronously before dispatch.
      invalidated.abort();
    };
    const terminal = await callGateway<unknown>({
      ...connection,
      method: "agent",
      scopes: [READ_SCOPE, WRITE_SCOPE],
      requiredMethods: ["agent"],
      timeoutMs: Math.max(1, deadlineAt - Date.now()),
      expectFinal: true,
      onHelloOk: inspectHello,
      params: {
        agentId,
        sessionKey,
        message: prompt,
        idempotencyKey: agentRunId,
        deliver: false,
        disableMessageTool: true,
        bootstrapContextMode: "lightweight",
        promptMode: "minimal",
        timeout: Math.max(1, Math.ceil((deadlineAt - Date.now()) / 1000)),
        label: "Update verification",
      },
      onAccepted: () => {
        acceptedRun = true;
      },
      onSignalAbort: async (request) => {
        await request("chat.abort", { sessionKey, runId: agentRunId }, { timeoutMs: 1_000 }).catch(
          () => {},
        );
      },
    });
    signal.throwIfAborted();
    if (isRecord(terminal) && terminal.status === "timeout") {
      return { status: "timeout", reason: "turn-timeout" };
    }
    const result = isRecord(terminal) && isRecord(terminal.result) ? terminal.result : undefined;
    const meta = result && isRecord(result.meta) ? result.meta : undefined;
    if (
      !gateway ||
      !isRecord(terminal) ||
      terminal.runId !== agentRunId ||
      terminal.status !== "ok" ||
      meta?.aborted ||
      meta?.yielded ||
      meta?.error ||
      !result ||
      !meta
    ) {
      return { status: "failed", reason: "turn-failed" };
    }
    stage = "persistence";
    // CLI backends can report native IDs in agentMeta.sessionId. The canonical
    // persistence owner, not harness metadata, supplies the receipt's session ID.
    const readbackParams = {
      config: params.config,
      env: params.env,
      agentId,
      sessionKey,
      agentRunId,
      prompt,
      response,
    };
    const readback = readUpdateServingTranscript(readbackParams);
    if (readback.status !== "persisted") {
      return {
        status: "failed",
        reason: readback.status === "not-found" ? "persistence-missing" : readback.status,
      };
    }
    stage = "gateway";
    // The original call closes after its final response. Reconnect explicitly to
    // observe the currently serving boot, not a pre-turn readiness observation.
    await callGateway({
      ...connection,
      method: "health",
      scopes: [READ_SCOPE],
      timeoutMs: Math.max(1, deadlineAt - Date.now()),
      onHelloOk: inspectHello,
    });
    signal.throwIfAborted();
    stage = "persistence";
    // No await follows this read. A rewrite/reset during the last RPC cannot
    // leave an apparently current receipt pointing at replaced transcript bytes.
    if (!isDeepStrictEqual(readback, readUpdateServingTranscript(readbackParams))) {
      return { status: "failed", reason: "persistence-changed" };
    }
    signal.throwIfAborted();
    if (Date.now() >= deadlineAt) {
      return { status: "timeout", reason: "deadline" };
    }
    const receipt = UpdateServingReceiptSchema.safeParse({
      runId: params.runId,
      gateway,
      agentId,
      sessionKey,
      sessionId: readback.sessionId,
      agentRunId,
      transcript: readback.transcript,
      verifiedAtMs: Date.now(),
    });
    return receipt.success
      ? { status: "verified", receipt: receipt.data }
      : { status: "failed", reason: "turn-incomplete" };
  } catch (error) {
    if (identityFailure) {
      return identityFailure;
    }
    if (params.signal?.aborted) {
      return { status: "failed", reason: "aborted" };
    }
    if (deadline.signal.aborted || (isGatewayTransportError(error) && error.kind === "timeout")) {
      return { status: "timeout", reason: "deadline" };
    }
    if (stage === "gateway" && acceptedRun) {
      return { status: "failed", reason: "turn-failed" };
    }
    return {
      status: "unavailable",
      reason:
        stage === "agent"
          ? "agent-unavailable"
          : stage === "persistence"
            ? "persistence-unavailable"
            : "gateway-unavailable",
    };
  } finally {
    clearTimeout(timer);
  }
}
