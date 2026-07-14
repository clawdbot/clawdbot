// QA Lab plugin module orchestrates WhatsApp live scenarios.
import fs from "node:fs/promises";
import path from "node:path";
import type {
  WhatsAppQaDriverObservedMessage,
  WhatsAppQaDriverSession,
} from "@openclaw/whatsapp/api.js";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { createQaArtifactRunId } from "../../artifact-run-id.js";
import { QA_EVIDENCE_FILENAME, buildLiveTransportEvidenceSummary } from "../../evidence-summary.js";
import { isTruthyOptIn } from "../../mantis-options.runtime.js";
import { DEFAULT_QA_LIVE_PROVIDER_MODE } from "../../providers/index.js";
import { fingerprintQaCredentialId } from "../../qa-credentials-fingerprint.runtime.js";
import {
  defaultQaModelForMode,
  normalizeQaProviderMode,
  type QaProviderModeInput,
} from "../../run-config.js";
import {
  acquireQaCredentialLease,
  startQaCredentialLeaseHeartbeat,
} from "../shared/credential-lease.runtime.js";
import { appendQaLiveLaneIssue as appendLiveLaneIssue } from "../shared/live-artifacts.js";
import { inferQaCredentialSource as inferWhatsAppCredentialSource } from "../shared/live-credential-source.js";
import { startQaLiveLaneGateway } from "../shared/live-gateway.runtime.js";
import {
  formatWhatsAppApprovalWaitDiagnostics,
  matchesWhatsAppApprovalResolvedText,
  runWhatsAppApprovalScenario,
} from "./whatsapp-live.approvals.js";
import {
  appendPreScenarioFailureResults,
  buildPublishedWhatsAppQaRunView,
  createMissingGroupJidScenarioResult,
  formatWhatsAppPreScenarioFailureLabel,
  formatWhatsAppScenarioProgressDetails,
  formatWhatsAppScenarioProgressLine,
  hasWhatsAppGatewayDebugArtifacts,
  redactWhatsAppQaScenarioResults,
  renderWhatsAppQaMarkdown,
  toObservedWhatsAppArtifacts,
} from "./whatsapp-live.artifacts.js";
import {
  buildWhatsAppQaConfig,
  parseWhatsAppQaCredentialPayload,
  resolveWhatsAppMetadataRedaction,
  resolveWhatsAppQaRuntimeEnv,
} from "./whatsapp-live.config.js";
import {
  WHATSAPP_QA_SCENARIO_POSTURES,
  buildWhatsAppQaScenarioResultBase,
  resolveWhatsAppQaMessageTargets,
  resolveWhatsAppQaScenarioTarget,
  toWhatsAppLiveTransportEvidenceChecks,
  type WhatsAppCredentialHeartbeat,
  type WhatsAppCredentialLease,
  type WhatsAppObservedMessage,
  type WhatsAppQaMessageScenarioContext,
  type WhatsAppQaPreScenarioPhase,
  type WhatsAppQaRunResult,
  type WhatsAppQaRuntimeEnv,
  type WhatsAppQaScenarioDefinition,
  type WhatsAppQaScenarioResult,
} from "./whatsapp-live.contracts.js";
import {
  WHATSAPP_QA_DRIVER_RECONNECT_DELAY_MS,
  WHATSAPP_QA_TRANSIENT_DRIVER_ATTEMPTS,
  assertWhatsAppScenarioMessageBatch,
  callWhatsAppGatewayMessageAction,
  callWhatsAppGatewayPoll,
  callWhatsAppGatewaySend,
  dedupeWhatsAppMessagesById,
  findUnexpectedWhatsAppNoReplyMessage,
  formatWhatsAppBatchMessageDiagnostics,
  formatWhatsAppScenarioWaitDiagnostics,
  isTransientWhatsAppQaDriverError,
  messageMatches,
  resolveWhatsAppQaNoReplyTarget,
  restartWhatsAppQaDriverSession,
  runWhatsAppStructuredInboundChecks,
  startWhatsAppQaDriverSessionWithRetry,
  waitForNoWhatsAppReply,
  waitForScenarioObservedMessage,
  waitForWhatsAppScenarioSutMessage,
} from "./whatsapp-live.operations.js";
import {
  WHATSAPP_QA_STANDARD_SCENARIO_IDS,
  buildWhatsAppQaMockAuthAgentIds,
  findScenarios,
} from "./whatsapp-live.scenarios.js";
import {
  assertSafeArchiveEntries,
  isWhatsAppChannelReady,
  unpackWhatsAppAuthArchive,
  waitForWhatsAppChannelStable,
} from "./whatsapp-live.setup.js";

const WHATSAPP_QA_CAPTURE_CONTENT_ENV = "OPENCLAW_QA_WHATSAPP_CAPTURE_CONTENT";

async function runWhatsAppScenario(params: {
  driver: WhatsAppQaDriverSession;
  driverPhoneE164: string;
  gatewayDebugDirPath: string;
  observedMessages: WhatsAppObservedMessage[];
  providerMode: ReturnType<typeof normalizeQaProviderMode>;
  primaryModel: string;
  alternateModel: string;
  fastMode?: boolean;
  repoRoot: string;
  scenario: WhatsAppQaScenarioDefinition;
  sutAccountId: string;
  sutAuthDir: string;
  sutPhoneE164: string;
  groupJid?: string;
  onGatewayDebugPreserveFailure?: (error: unknown) => void;
  onGatewayDebugPreserved?: () => void;
}): Promise<WhatsAppQaScenarioResult> {
  const scenarioRun = params.scenario.buildRun();
  const resolvedTarget = resolveWhatsAppQaScenarioTarget({
    groupJid: params.groupJid,
    scenarioId: params.scenario.id,
    target: scenarioRun.kind === "approval" ? (scenarioRun.target ?? "dm") : scenarioRun.target,
  });
  const groupJidForScenario =
    resolvedTarget.target === "group" ? resolvedTarget.groupJid : undefined;
  const targets =
    scenarioRun.kind !== "approval"
      ? resolveWhatsAppQaMessageTargets({
          driverPhoneE164: params.driverPhoneE164,
          groupJid: params.groupJid,
          scenarioTarget: scenarioRun.target,
          sutPhoneE164: params.sutPhoneE164,
        })
      : undefined;
  const target = targets?.driverTarget ?? params.sutPhoneE164;
  const approvalTurnSourceTo =
    scenarioRun.kind === "approval" && resolvedTarget.target === "group"
      ? resolvedTarget.groupJid
      : params.driverPhoneE164;
  const allowFrom =
    scenarioRun.kind === "approval"
      ? [params.driverPhoneE164]
      : scenarioRun.configMode === "open"
        ? ["*"]
        : scenarioRun.configMode === "pairing"
          ? ["+15550000000"]
          : [params.driverPhoneE164];
  const dmPolicy =
    scenarioRun.kind === "approval"
      ? "allowlist"
      : scenarioRun.configMode === "open" || scenarioRun.configMode === "disabled"
        ? scenarioRun.configMode
        : scenarioRun.configMode === "allowlist"
          ? "allowlist"
          : "pairing";
  const gatewayHarness = await startQaLiveLaneGateway({
    repoRoot: params.repoRoot,
    transport: {
      requiredPluginIds: params.scenario.requiredPluginIds ?? [],
      createGatewayConfig: () => ({}),
    },
    transportBaseUrl: "http://127.0.0.1:0",
    command: {
      executablePath: process.execPath,
      argsPrefix: [path.join(params.repoRoot, "dist", "index.js")],
      argsSuffix: ["--verbose"],
    },
    providerMode: params.providerMode,
    primaryModel: params.primaryModel,
    alternateModel: params.alternateModel,
    fastMode: params.fastMode,
    controlUiEnabled: false,
    mockAuthAgentIds: buildWhatsAppQaMockAuthAgentIds(params.scenario),
    mutateConfig: (cfg) =>
      buildWhatsAppQaConfig(cfg, {
        allowFrom,
        authDir: params.sutAuthDir,
        dmPolicy,
        groupJid: groupJidForScenario,
        overrides: params.scenario.configOverrides,
        sutAccountId: params.sutAccountId,
      }),
  });
  let preservedGatewayDebug = false;
  try {
    await waitForWhatsAppChannelStable(gatewayHarness.gateway, params.sutAccountId);
    if (scenarioRun.kind === "approval") {
      const approval = await runWhatsAppApprovalScenario({
        driver: params.driver,
        gateway: gatewayHarness.gateway,
        observedMessages: params.observedMessages,
        run: scenarioRun,
        scenario: params.scenario,
        sutAccountId: params.sutAccountId,
        sutPhoneE164: params.sutPhoneE164,
        turnSourceTo: approvalTurnSourceTo,
      });
      return {
        ...buildWhatsAppQaScenarioResultBase(params.scenario),
        status: "pass" as const,
        details: `${scenarioRun.approvalKind} approval ${approval.approvalId} resolved ${scenarioRun.decision} in ${approval.rttMs}ms`,
        rttMs: approval.rttMs,
        requestStartedAt: approval.requestStartedAt.toISOString(),
        responseObservedAt: approval.responseObservedAt.toISOString(),
        rttMeasurement: {
          finalMatchedReplyRttMs: approval.rttMs,
          requestStartedAt: approval.requestStartedAt.toISOString(),
          responseObservedAt: approval.responseObservedAt.toISOString(),
          source: "approval-request-to-resolution" as const,
        },
      };
    }
    if (scenarioRun.quietInput !== undefined) {
      const quietStartedAt = new Date();
      const quietSendMode = scenarioRun.quietSendMode ?? scenarioRun.sendMode;
      if (quietSendMode?.kind === "media") {
        await params.driver.sendMedia(
          target,
          scenarioRun.quietInput,
          quietSendMode.mediaBuffer,
          quietSendMode.mediaType,
          {
            fileName: quietSendMode.fileName,
          },
        );
      } else {
        await params.driver.sendText(target, scenarioRun.quietInput);
      }
      const quietMatchText = scenarioRun.quietMatchText;
      await waitForNoWhatsAppReply({
        ...(quietMatchText
          ? {
              allowQuietWindowMessage: (message: WhatsAppQaDriverObservedMessage) =>
                !messageMatches(message as WhatsAppObservedMessage, quietMatchText),
            }
          : {}),
        driver: params.driver,
        observedAfter: quietStartedAt,
        sutPhoneE164: params.sutPhoneE164,
        windowMs: scenarioRun.quietWindowMs ?? 5_000,
        ...resolveWhatsAppQaNoReplyTarget({
          groupJid: params.groupJid,
          target: scenarioRun.target,
        }),
      });
      await waitForWhatsAppChannelStable(gatewayHarness.gateway, params.sutAccountId);
    }
    const requestStartedAt = new Date();
    const sent =
      scenarioRun.sendMode?.kind === "media"
        ? await params.driver.sendMedia(
            target,
            scenarioRun.input,
            scenarioRun.sendMode.mediaBuffer,
            scenarioRun.sendMode.mediaType,
            {
              fileName: scenarioRun.sendMode.fileName,
            },
          )
        : await params.driver.sendText(target, scenarioRun.input);
    const scenarioContext: WhatsAppQaMessageScenarioContext = {
      driver: params.driver,
      driverPhoneE164: params.driverPhoneE164,
      gateway: gatewayHarness.gateway,
      gatewayTarget: targets?.gatewayTarget ?? params.driverPhoneE164,
      gatewayWorkspaceDir: gatewayHarness.gateway.workspaceDir,
      recordObservedMessage: (message) => {
        params.observedMessages.push({
          ...message,
          matchedScenario: true,
          scenarioId: params.scenario.id,
          scenarioTitle: params.scenario.title,
        });
      },
      requestStartedAt,
      scenarioId: params.scenario.id,
      scenarioTitle: params.scenario.title,
      sent,
      sutAccountId: params.sutAccountId,
      sutPhoneE164: params.sutPhoneE164,
      target,
      targetKind: scenarioRun.target,
      waitForReady: async () => {
        await waitForWhatsAppChannelStable(gatewayHarness.gateway, params.sutAccountId);
      },
    };
    const afterSendDetails = await scenarioRun.afterSend?.(scenarioContext);
    if (!scenarioRun.expectReply) {
      await waitForNoWhatsAppReply({
        allowQuietWindowMessage: (message) =>
          scenarioRun.allowQuietWindowMessage?.(message, scenarioContext) ?? false,
        driver: params.driver,
        observedAfter: requestStartedAt,
        sutPhoneE164: params.sutPhoneE164,
        windowMs: scenarioRun.quietWindowMs ?? params.scenario.timeoutMs,
        ...resolveWhatsAppQaNoReplyTarget({
          groupJid: params.groupJid,
          target: scenarioRun.target,
        }),
      });
      return {
        ...buildWhatsAppQaScenarioResultBase(params.scenario),
        status: "pass" as const,
        details: ["no reply", afterSendDetails].filter(Boolean).join("; "),
      };
    }
    const reply = await waitForWhatsAppScenarioSutMessage(scenarioContext, {
      observedAfter: requestStartedAt,
      timeoutMs: params.scenario.timeoutMs,
      targetKind: scenarioRun.target,
      match: (message) => messageMatches(message as WhatsAppObservedMessage, scenarioRun.matchText),
    });
    scenarioRun.verify?.(reply, scenarioContext);
    const afterReplyDetails = await scenarioRun.afterReply?.(reply, scenarioContext);
    const batchDetails = await assertWhatsAppScenarioMessageBatch({
      alreadyRecordedMessageIds: new Set(reply.messageId ? [reply.messageId] : []),
      context: scenarioContext,
      observedAfter: requestStartedAt,
      run: scenarioRun,
    });
    const responseObservedAt = new Date(reply.observedAt);
    const rttMs = responseObservedAt.getTime() - requestStartedAt.getTime();
    return {
      ...buildWhatsAppQaScenarioResultBase(params.scenario),
      status: "pass" as const,
      details: [`reply matched in ${rttMs}ms`, afterSendDetails, afterReplyDetails, batchDetails]
        .filter(Boolean)
        .join("; "),
      rttMs,
      requestStartedAt: requestStartedAt.toISOString(),
      responseObservedAt: responseObservedAt.toISOString(),
      rttMeasurement: {
        finalMatchedReplyRttMs: rttMs,
        requestStartedAt: requestStartedAt.toISOString(),
        responseObservedAt: responseObservedAt.toISOString(),
        source: "request-to-observed-message" as const,
      },
    };
  } catch (error) {
    try {
      await gatewayHarness.stop({ preserveToDir: params.gatewayDebugDirPath });
      preservedGatewayDebug = true;
      params.onGatewayDebugPreserved?.();
    } catch (preserveError) {
      params.onGatewayDebugPreserveFailure?.(preserveError);
    }
    throw error;
  } finally {
    if (!preservedGatewayDebug) {
      await gatewayHarness.stop().catch(() => {});
    }
  }
}

function logWhatsAppScenarioProgress(
  params: Parameters<typeof formatWhatsAppScenarioProgressLine>[0],
) {
  process.stderr.write(`${formatWhatsAppScenarioProgressLine(params)}\n`);
}

export async function runWhatsAppQaLive(params: {
  alternateModel?: string;
  credentialRole?: string;
  credentialSource?: string;
  fastMode?: boolean;
  outputDir?: string;
  primaryModel?: string;
  providerMode?: QaProviderModeInput;
  repoRoot?: string;
  scenarioIds?: string[];
  sutAccountId?: string;
}): Promise<WhatsAppQaRunResult> {
  const repoRoot = path.resolve(params.repoRoot ?? process.cwd());
  const outputDir =
    params.outputDir ??
    path.join(repoRoot, ".artifacts", "qa-e2e", `whatsapp-${createQaArtifactRunId()}`);
  await fs.mkdir(outputDir, { recursive: true });

  const providerMode = normalizeQaProviderMode(
    params.providerMode ?? DEFAULT_QA_LIVE_PROVIDER_MODE,
  );
  const primaryModel = params.primaryModel?.trim() || defaultQaModelForMode(providerMode);
  const alternateModel = params.alternateModel?.trim() || defaultQaModelForMode(providerMode, true);
  const sutAccountId = params.sutAccountId?.trim() || "sut";
  const scenarios = findScenarios(params.scenarioIds, providerMode);
  const explicitScenarioSelection = (params.scenarioIds?.length ?? 0) > 0;
  const requestedCredentialSource = inferWhatsAppCredentialSource(params.credentialSource);
  const redactPublicMetadata = resolveWhatsAppMetadataRedaction();
  const includeObservedMessageContent = isTruthyOptIn(process.env[WHATSAPP_QA_CAPTURE_CONTENT_ENV]);
  const startedAt = new Date().toISOString();
  const observedMessages: WhatsAppObservedMessage[] = [];
  const scenarioResults: WhatsAppQaScenarioResult[] = [];
  const cleanupIssues: string[] = [];
  const gatewayDebugDirPath = path.join(outputDir, "gateway-debug");
  let preservedGatewayDebugArtifacts = false;
  let credentialLease: WhatsAppCredentialLease | undefined;
  let leaseHeartbeat: WhatsAppCredentialHeartbeat | undefined;
  let runtimeEnv: WhatsAppQaRuntimeEnv | undefined;
  let tempAuthRoot: string | undefined;
  let closeDriverSession: (() => Promise<void>) | undefined;
  let preScenarioPhase: WhatsAppQaPreScenarioPhase = "credential lease acquisition";

  try {
    credentialLease = await acquireQaCredentialLease({
      kind: "whatsapp",
      source: params.credentialSource,
      role: params.credentialRole,
      resolveEnvPayload: () => resolveWhatsAppQaRuntimeEnv(),
      parsePayload: parseWhatsAppQaCredentialPayload,
    });
    preScenarioPhase = "credential heartbeat start";
    leaseHeartbeat = startQaCredentialLeaseHeartbeat(credentialLease);
    const assertLeaseHealthy = () => {
      leaseHeartbeat?.throwIfFailed();
    };
    runtimeEnv = credentialLease.payload;
    tempAuthRoot = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-whatsapp-qa-"),
    );
    preScenarioPhase = "auth archive unpack";
    const [driverAuthDir, sutAuthDir] = await Promise.all([
      unpackWhatsAppAuthArchive({
        archiveBase64: runtimeEnv.driverAuthArchiveBase64,
        clearSignalSessions: true,
        label: "driver-auth",
        parentDir: tempAuthRoot,
      }),
      unpackWhatsAppAuthArchive({
        archiveBase64: runtimeEnv.sutAuthArchiveBase64,
        clearSignalSessions: true,
        label: "sut-auth",
        parentDir: tempAuthRoot,
      }),
    ]);
    preScenarioPhase = "driver session start";
    let activeDriver = await startWhatsAppQaDriverSessionWithRetry({ authDir: driverAuthDir });
    closeDriverSession = () => activeDriver.close();
    preScenarioPhase = "scenario execution";

    for (const [scenarioIndex, scenario] of scenarios.entries()) {
      const progressIndex = scenarioIndex + 1;
      logWhatsAppScenarioProgress({
        index: progressIndex,
        scenario,
        status: "start",
        total: scenarios.length,
      });
      assertLeaseHealthy();
      if (scenario.requiresGroupJid && !runtimeEnv.groupJid) {
        const result = createMissingGroupJidScenarioResult({
          explicitScenarioSelection,
          scenario,
        });
        scenarioResults.push(result);
        logWhatsAppScenarioProgress({
          details: formatWhatsAppScenarioProgressDetails({
            details: result.details,
            redactMetadata: redactPublicMetadata,
          }),
          index: progressIndex,
          scenario,
          status: result.status,
          total: scenarios.length,
        });
        continue;
      }
      let driverAttempt = 1;
      while (true) {
        let scenarioGatewayDebugPreserved = false;
        const scenarioGatewayDebugPreserveFailures: unknown[] = [];
        try {
          const result = await runWhatsAppScenario({
            driver: activeDriver,
            driverPhoneE164: runtimeEnv.driverPhoneE164,
            gatewayDebugDirPath,
            observedMessages,
            providerMode,
            primaryModel,
            alternateModel,
            fastMode: params.fastMode,
            groupJid: runtimeEnv.groupJid,
            repoRoot,
            scenario,
            sutAccountId,
            sutAuthDir,
            sutPhoneE164: runtimeEnv.sutPhoneE164,
            onGatewayDebugPreserved: () => {
              scenarioGatewayDebugPreserved = true;
            },
            onGatewayDebugPreserveFailure: (error) => {
              scenarioGatewayDebugPreserveFailures.push(error);
            },
          });
          const recordedResult =
            driverAttempt > 1
              ? {
                  ...result,
                  details: `${result.details}; driver reconnected ${driverAttempt - 1}x`,
                }
              : result;
          scenarioResults.push(recordedResult);
          logWhatsAppScenarioProgress({
            details: formatWhatsAppScenarioProgressDetails({
              details: recordedResult.details,
              redactMetadata: redactPublicMetadata,
            }),
            index: progressIndex,
            scenario,
            status: recordedResult.status,
            total: scenarios.length,
          });
          break;
        } catch (error) {
          if (
            driverAttempt < WHATSAPP_QA_TRANSIENT_DRIVER_ATTEMPTS &&
            isTransientWhatsAppQaDriverError(error)
          ) {
            driverAttempt += 1;
            await new Promise((resolve) => {
              setTimeout(resolve, WHATSAPP_QA_DRIVER_RECONNECT_DELAY_MS);
            });
            activeDriver = await restartWhatsAppQaDriverSession({
              authDir: driverAuthDir,
              current: activeDriver,
            });
            closeDriverSession = () => activeDriver.close();
            continue;
          }
          if (scenarioGatewayDebugPreserved) {
            preservedGatewayDebugArtifacts = true;
          }
          for (const preserveError of scenarioGatewayDebugPreserveFailures) {
            appendLiveLaneIssue(cleanupIssues, "gateway debug preserve failed", preserveError);
          }
          const result: WhatsAppQaScenarioResult = {
            ...buildWhatsAppQaScenarioResultBase(scenario),
            status: "fail",
            details:
              driverAttempt > 1
                ? `${formatErrorMessage(error)}; driver reconnected ${driverAttempt - 1}x`
                : formatErrorMessage(error),
          };
          scenarioResults.push(result);
          logWhatsAppScenarioProgress({
            details: formatWhatsAppScenarioProgressDetails({
              details: result.details,
              redactMetadata: redactPublicMetadata,
            }),
            index: progressIndex,
            scenario,
            status: "fail",
            total: scenarios.length,
          });
          break;
        }
      }
      if (scenarioResults.at(-1)?.status === "fail") {
        break;
      }
    }
  } catch (error) {
    const failureLabel = formatWhatsAppPreScenarioFailureLabel(preScenarioPhase);
    appendLiveLaneIssue(cleanupIssues, failureLabel, error);
    appendPreScenarioFailureResults({
      details: `${failureLabel}: ${formatErrorMessage(error)}`,
      scenarioResults,
      scenarios,
    });
  } finally {
    if (closeDriverSession) {
      try {
        await closeDriverSession();
      } catch (error) {
        appendLiveLaneIssue(cleanupIssues, "driver session stop failed", error);
      }
    }
    if (leaseHeartbeat) {
      try {
        await leaseHeartbeat.stop();
      } catch (error) {
        appendLiveLaneIssue(cleanupIssues, "credential heartbeat stop failed", error);
      }
    }
    if (credentialLease) {
      try {
        await credentialLease.release();
      } catch (error) {
        appendLiveLaneIssue(cleanupIssues, "credential release failed", error);
      }
    }
    if (tempAuthRoot) {
      await fs.rm(tempAuthRoot, { recursive: true, force: true }).catch((error: unknown) => {
        appendLiveLaneIssue(cleanupIssues, "temporary auth cleanup failed", error);
      });
    }
  }

  const finishedAt = new Date().toISOString();
  const reportPath = path.join(outputDir, "whatsapp-qa-report.md");
  const summaryPath = path.join(outputDir, QA_EVIDENCE_FILENAME);
  const observedMessagesPath = path.join(outputDir, "whatsapp-qa-observed-messages.json");
  const credentialFingerprint = fingerprintQaCredentialId(credentialLease?.credentialId);
  const publishedRunView = await buildPublishedWhatsAppQaRunView({
    cleanupIssues,
    gatewayDebugDirPath,
    preservedGatewayDebugArtifacts,
    redactMetadata: redactPublicMetadata,
    scenarioResults,
  });
  const evidence = buildLiveTransportEvidenceSummary({
    artifactPaths: [
      { kind: "summary", path: path.basename(summaryPath) },
      { kind: "report", path: path.basename(reportPath) },
      { kind: "transport-observations", path: path.basename(observedMessagesPath) },
    ],
    checks: toWhatsAppLiveTransportEvidenceChecks(publishedRunView.scenarioResults),
    env: process.env,
    generatedAt: finishedAt,
    primaryModel,
    providerMode,
    repoRoot,
    transportId: "whatsapp",
  });
  await fs.writeFile(
    observedMessagesPath,
    `${JSON.stringify(
      toObservedWhatsAppArtifacts({
        messages: observedMessages,
        includeContent: includeObservedMessageContent,
        redactMetadata: redactPublicMetadata,
      }),
      null,
      2,
    )}\n`,
  );
  await fs.writeFile(summaryPath, `${JSON.stringify(evidence, null, 2)}\n`);
  await fs.writeFile(
    reportPath,
    `${renderWhatsAppQaMarkdown({
      cleanupIssues: publishedRunView.cleanupIssues,
      credentialFingerprint,
      credentialSource: credentialLease?.source ?? requestedCredentialSource,
      finishedAt,
      gatewayDebugDirPath: publishedRunView.gatewayDebugDirPath,
      redactMetadata: redactPublicMetadata,
      scenarios: publishedRunView.scenarioResults,
      startedAt,
      sutPhoneE164: runtimeEnv?.sutPhoneE164,
    })}\n`,
  );
  return {
    outputDir,
    reportPath,
    summaryPath,
    observedMessagesPath,
    gatewayDebugDirPath: publishedRunView.gatewayDebugDirPath,
    scenarios: scenarioResults,
  };
}

export const testing = {
  assertSafeArchiveEntries,
  appendPreScenarioFailureResults,
  buildPublishedWhatsAppQaRunView,
  buildWhatsAppQaConfig,
  buildWhatsAppQaMockAuthAgentIds,
  callWhatsAppGatewayMessageAction,
  callWhatsAppGatewayPoll,
  callWhatsAppGatewaySend,
  createMissingGroupJidScenarioResult,
  findScenarios,
  findUnexpectedWhatsAppNoReplyMessage,
  formatWhatsAppApprovalWaitDiagnostics,
  formatWhatsAppBatchMessageDiagnostics,
  formatWhatsAppPreScenarioFailureLabel,
  formatWhatsAppScenarioProgressDetails,
  formatWhatsAppScenarioProgressLine,
  dedupeWhatsAppMessagesById,
  fingerprintWhatsAppCredentialId: fingerprintQaCredentialId,
  formatWhatsAppScenarioWaitDiagnostics,
  hasWhatsAppGatewayDebugArtifacts,
  isWhatsAppChannelReady,
  isTransientWhatsAppQaDriverError,
  matchesWhatsAppApprovalResolvedText,
  parseWhatsAppQaCredentialPayload,
  renderWhatsAppQaMarkdown,
  runWhatsAppApprovalScenario,
  runWhatsAppStructuredInboundChecks,
  waitForScenarioObservedMessage,
  waitForWhatsAppChannelStable,
  redactWhatsAppQaScenarioResults,
  resolveWhatsAppQaMessageTargets,
  resolveWhatsAppQaRuntimeEnv,
  resolveWhatsAppMetadataRedaction,
  toObservedWhatsAppArtifacts,
  toWhatsAppLiveTransportEvidenceChecks,
  unpackWhatsAppAuthArchive,
  WHATSAPP_QA_STANDARD_SCENARIO_IDS,
  WHATSAPP_QA_SCENARIO_POSTURES,
};
export { testing as __testing };
export { listWhatsAppQaScenarioCatalog } from "./whatsapp-live.scenarios.js";
