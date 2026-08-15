/**
 * Exec tool policy, host dispatch, and process lifecycle pipeline.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveStateDir } from "../config/paths.js";
import { createAbortError } from "../infra/abort-signal.js";
import {
  type ExecHost,
  loadExecApprovals,
  maxAsk,
  minSecurity,
  normalizeExecAsk,
  requireValidExecTarget,
  resolveExecApprovalsFromFile,
  resolveExecModePolicy,
} from "../infra/exec-approvals.js";
import {
  rejectUnsafeExecControlShellCommand,
  rejectUnsafeExecLiveStateSqliteShellCommand,
} from "../infra/exec-control-command-guard.js";
import { resolveExecSafeBinRuntimePolicy } from "../infra/exec-safe-bin-runtime-policy.js";
import { logInfo } from "../logger.js";
import { parseAgentSessionKey, resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import {
  isSecretEgressProxyActive,
  registerSecretEgressProxyRun,
} from "../secrets/egress-proxy/registry.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import { markBackgrounded } from "./bash-process-registry.js";
import { describeExecTool } from "./bash-tools.descriptions.js";
import { processGatewayAllowlist } from "./bash-tools.exec-host-gateway.js";
import { executeNodeHostCommand } from "./bash-tools.exec-host-node.js";
import {
  createExecRequestPreparation,
  type ExecToolArgs,
  resolveNotifyOnExitEmptySuccess,
  resolvePreparedExecEnvironment,
} from "./bash-tools.exec-request-preparation.js";
import {
  DEFAULT_MAX_OUTPUT,
  DEFAULT_PENDING_MAX_OUTPUT,
  type ExecProcessHandle,
  type ExecProcessOutcome,
  normalizePathPrepend,
  resolveExecTarget,
  resolveApprovalRunningNoticeMs,
  buildExecRuntimeErrorOutcome,
  runExecProcess,
  execSchema,
} from "./bash-tools.exec-runtime.js";
import {
  shouldSkipExecScriptPreflight,
  validateScriptFileForShellBleed,
} from "./bash-tools.exec-script-preflight.js";
import {
  buildExecForegroundResult,
  createExecHostResolver,
  resolveExecReviewerDefaults,
} from "./bash-tools.exec-support.js";
import {
  type BackgroundExecTaskHandle,
  createBackgroundExecTask,
  finalizeBackgroundExecTask,
} from "./bash-tools.exec-task-tracking.js";
import type { ExecToolDefaults, ExecToolDetails } from "./bash-tools.exec-types.js";
import { formatUnavailableWorkdirFailure, resolveExecWorkdir } from "./bash-tools.exec-workdir.js";
import { clampWithDefault, readEnvInt, truncateMiddle } from "./bash-tools.shared.js";
import { createModelExecAutoReviewer } from "./exec-auto-reviewer.js";
import type { AgentToolResult } from "./runtime/index.js";
import { EXEC_TOOL_DISPLAY_SUMMARY } from "./tool-description-presets.js";
import type { AgentToolWithMeta } from "./tools/common.js";

/** Creates an exec tool instance with runtime defaults and approval policy wiring. */
export function createExecTool(
  defaults?: ExecToolDefaults,
): AgentToolWithMeta<typeof execSchema, ExecToolDetails> {
  const secretEgressEnabled = isSecretEgressProxyActive();
  // Agent runs own one tool instance, so the store is read on first exec and reused for that run.
  // A new run constructs a new instance and observes later store mutations.
  let storeEnvPromise:
    | Promise<import("../secrets/store/secret-store.js").SecretStoreExecEnvironment>
    | undefined;
  const resolveStoreEnv = () => {
    storeEnvPromise ??= import("../secrets/store/secret-store.js").then((store) => {
      return store.readSecretStoreExecEnvironment({
        includeSecretSentinels: secretEgressEnabled,
      });
    });
    return storeEnvPromise;
  };
  const defaultBackgroundMs = clampWithDefault(
    defaults?.backgroundMs ?? readEnvInt("OPENCLAW_BASH_YIELD_MS", "PI_BASH_YIELD_MS"),
    10_000,
    10,
    120_000,
  );
  const allowBackground = defaults?.allowBackground ?? true;
  const defaultTimeoutSec =
    typeof defaults?.timeoutSec === "number" && defaults.timeoutSec > 0
      ? defaults.timeoutSec
      : 1800;
  const defaultPathPrepend = normalizePathPrepend(defaults?.pathPrepend);
  const {
    safeBins,
    safeBinProfiles,
    trustedSafeBinDirs,
    unprofiledSafeBins,
    unprofiledInterpreterSafeBins,
  } = resolveExecSafeBinRuntimePolicy({
    local: {
      safeBins: defaults?.safeBins,
      safeBinTrustedDirs: defaults?.safeBinTrustedDirs,
      safeBinProfiles: defaults?.safeBinProfiles,
    },
    onWarning: (message) => {
      logInfo(message);
    },
  });
  if (unprofiledSafeBins.length > 0) {
    logInfo(
      `exec: ignoring unprofiled safeBins entries (${unprofiledSafeBins.toSorted().join(", ")}); use allowlist or define tools.exec.safeBinProfiles.<bin>`,
    );
  }
  if (unprofiledInterpreterSafeBins.length > 0) {
    logInfo(
      `exec: interpreter/runtime binaries in safeBins (${unprofiledInterpreterSafeBins.join(", ")}) are unsafe without explicit hardened profiles; prefer allowlist entries`,
    );
  }
  const notifyOnExit = defaults?.notifyOnExit !== false;
  const notifyOnExitEmptySuccess = resolveNotifyOnExitEmptySuccess(defaults);
  const notifySessionKey = normalizeOptionalString(
    defaults?.notifySessionKey ?? defaults?.sessionKey,
  );
  const notifyDeliveryContext = normalizeDeliveryContext({
    channel: defaults?.messageProvider,
    to: defaults?.currentChannelId,
    accountId: defaults?.accountId,
    threadId: defaults?.currentThreadTs,
  });
  const approvalRunningNoticeMs = resolveApprovalRunningNoticeMs(defaults?.approvalRunningNoticeMs);
  // Derive agentId only when sessionKey is an agent session key.
  const parsedAgentSession = parseAgentSessionKey(defaults?.sessionKey);
  const agentId =
    defaults?.agentId ??
    (parsedAgentSession ? resolveAgentIdFromSessionKey(defaults?.sessionKey) : undefined);
  const resolveHostForParams = createExecHostResolver(defaults);
  const buildUnavailableWorkdirResult = (params: {
    cwd: string;
    startedAt?: number;
    warningText?: string;
  }) =>
    buildExecForegroundResult({
      outcome: buildExecRuntimeErrorOutcome({
        error: formatUnavailableWorkdirFailure(params.cwd),
        aggregated: "",
        durationMs: params.startedAt ? Date.now() - params.startedAt : 0,
      }),
      cwd: params.cwd,
      warningText: params.warningText,
    });
  const requestPreparation = createExecRequestPreparation({
    defaults,
    agentId,
    resolveHostForParams,
  });
  return {
    name: "exec",
    label: "exec",
    displaySummary: EXEC_TOOL_DISPLAY_SUMMARY,
    get description() {
      return describeExecTool({ agentId, hasCronTool: defaults?.hasCronTool === true });
    },
    parameters: execSchema,
    prepareBeforeToolCallParams: requestPreparation.prepareBeforeToolCallParams,
    finalizeBeforeToolCallParams: requestPreparation.finalizeBeforeToolCallParams,
    execute: async (toolCallId, args, signal, onUpdate) => {
      signal?.throwIfAborted();
      if (Object.hasOwn(args, "timeout")) {
        throw new Error('exec parameter "timeout" is unsupported; use "timeoutSeconds" instead');
      }
      // Review cancellation belongs to this execution, never another call on the shared tool.
      const autoReviewer =
        defaults?.autoReviewer ??
        createModelExecAutoReviewer({
          cfg: defaults?.config,
          agentId,
          reviewer: resolveExecReviewerDefaults({ defaults, agentId }),
          signal,
        });
      let params = requestPreparation.normalizeParams(args);
      const resolveExecEnvPrepared = requestPreparation.isResolveExecEnvPrepared(
        args as ExecToolArgs,
      );
      const deferredResolveExecEnvState =
        requestPreparation.getDeferredResolveExecEnvPreparedState(params);
      const preparedWorkdirState = requestPreparation.getResolvedExecWorkdirPreparedState(params);

      const maxOutput = DEFAULT_MAX_OUTPUT;
      const pendingMaxOutput = DEFAULT_PENDING_MAX_OUTPUT;
      const warnings: string[] = [];
      const getWarningText = () => (warnings.length ? `${warnings.join("\n")}\n\n` : "");
      const approvalWarningText = normalizeOptionalString(defaults?.approvalWarningText);
      if (approvalWarningText) {
        warnings.push(approvalWarningText);
      }
      const startedAt = Date.now();
      let execCommandOverride: string | undefined;
      const backgroundRequested = params.background === true;
      const yieldRequested = typeof params.yieldMs === "number";
      const foregroundFallbackWarning =
        !allowBackground && (backgroundRequested || yieldRequested)
          ? "Warning: background execution is disabled; running synchronously."
          : undefined;
      const yieldWindow = allowBackground
        ? backgroundRequested
          ? 0
          : clampWithDefault(
              params.yieldMs ?? defaultBackgroundMs,
              defaultBackgroundMs,
              10,
              120_000,
            )
        : null;
      const elevatedDefaults = defaults?.elevated;
      const elevatedAllowed = Boolean(elevatedDefaults?.enabled && elevatedDefaults.allowed);
      const elevatedDefaultMode =
        elevatedDefaults?.defaultLevel === "full"
          ? "full"
          : elevatedDefaults?.defaultLevel === "ask"
            ? "ask"
            : elevatedDefaults?.defaultLevel === "on"
              ? "ask"
              : "off";
      const effectiveDefaultMode = elevatedAllowed ? elevatedDefaultMode : "off";
      const elevatedMode =
        typeof params.elevated === "boolean"
          ? params.elevated
            ? elevatedDefaultMode === "full"
              ? "full"
              : "ask"
            : "off"
          : effectiveDefaultMode;
      const elevatedRequested = elevatedMode !== "off";
      if (elevatedRequested) {
        if (!elevatedDefaults?.enabled || !elevatedDefaults.allowed) {
          const runtime = defaults?.sandbox ? "sandboxed" : "direct";
          const gates: string[] = [];
          const contextParts: string[] = [];
          const provider = normalizeOptionalString(defaults?.messageProvider);
          const sessionKey = normalizeOptionalString(defaults?.sessionKey);
          if (provider) {
            contextParts.push(`provider=${provider}`);
          }
          if (sessionKey) {
            contextParts.push(`session=${sessionKey}`);
          }
          if (!elevatedDefaults?.enabled) {
            gates.push(
              "enabled (tools.elevated.enabled / agents.entries.*.tools.elevated.enabled)",
            );
          } else {
            gates.push(
              "allowFrom (tools.elevated.allowFrom.<provider> / agents.entries.*.tools.elevated.allowFrom.<provider>)",
            );
          }
          throw new Error(
            [
              `elevated is not available right now (runtime=${runtime}).`,
              `Failing gates: ${gates.join(", ")}`,
              contextParts.length > 0 ? `Context: ${contextParts.join(" ")}` : undefined,
              "Fix-it keys:",
              "- tools.elevated.enabled",
              "- tools.elevated.allowFrom.<provider>",
              "- agents.entries.*.tools.elevated.enabled",
              "- agents.entries.*.tools.elevated.allowFrom.<provider>",
            ]
              .filter(Boolean)
              .join("\n"),
          );
        }
      }
      const requestedTarget = requireValidExecTarget(params.host);
      const target = resolveExecTarget({
        configuredTarget: defaults?.host,
        requestedTarget,
        elevatedRequested,
        sandboxAvailable: Boolean(defaults?.sandbox),
      });
      const host: ExecHost = target.effectiveHost;

      const explicitSecurity = defaults?.security;
      const configuredSecurity = explicitSecurity ?? (host === "sandbox" ? "deny" : "full");
      const modePolicy = resolveExecModePolicy({
        mode: defaults?.mode,
        security: configuredSecurity,
        ask: defaults?.ask ?? "off",
      });
      const approvalPolicy =
        host === "sandbox"
          ? undefined
          : resolveExecApprovalsFromFile({
              file: loadExecApprovals(),
              agentId,
              overrides: {
                security: "full",
                ask: "off",
              },
            }).agent;
      let security = minSecurity(
        modePolicy.security,
        approvalPolicy?.security ?? modePolicy.security,
      );
      if (
        security === "deny" &&
        (host !== "sandbox" || defaults?.mode === "deny" || explicitSecurity === "deny")
      ) {
        throw new Error(`exec denied: host=${host} security=deny`);
      }
      const hostPolicyAllowsFullBypass =
        (approvalPolicy?.security ?? "full") === "full" && (approvalPolicy?.ask ?? "off") === "off";
      const modePolicyAllowsFullBypass = modePolicy.security === "full" && modePolicy.ask === "off";
      if (
        elevatedRequested &&
        elevatedMode === "full" &&
        modePolicyAllowsFullBypass &&
        hostPolicyAllowsFullBypass
      ) {
        security = "full";
      }
      // Keep local exec defaults in sync with host approval state when tools.exec.* is unset.
      const requestedAsk = normalizeExecAsk(params.ask);
      const hostAsk = maxAsk(modePolicy.ask, approvalPolicy?.ask ?? modePolicy.ask);
      const trustedAsk = defaults?.messageProvider && hostAsk === "off" ? undefined : requestedAsk;
      let ask = maxAsk(hostAsk, trustedAsk ?? hostAsk);
      const bypassApprovals =
        elevatedRequested &&
        elevatedMode === "full" &&
        modePolicyAllowsFullBypass &&
        hostPolicyAllowsFullBypass;
      if (bypassApprovals) {
        ask = "off";
      }
      const autoReview = modePolicy.autoReview && ask === modePolicy.ask && !bypassApprovals;

      const sandbox = host === "sandbox" ? defaults?.sandbox : undefined;
      if (target.selectedTarget === "sandbox" && !sandbox) {
        throw new Error(
          [
            "exec host=sandbox requires a sandbox runtime for this session.",
            'Enable sandbox mode (`agents.defaults.sandbox.mode="non-main"` or `"all"`) or use host=auto/gateway/node.',
          ].join("\n"),
        );
      }
      if (!params.command) {
        throw new Error("Provide a command to start.");
      }
      await rejectUnsafeExecControlShellCommand(params.command);
      let workdir: string | undefined;
      let scriptPreflightCwd: string | null = null;
      let containerWorkdir = sandbox?.containerWorkdir;
      let discardPreparedSandboxWorkdir: (() => void) | null = null;
      const workdirResolution =
        preparedWorkdirState?.host === host
          ? preparedWorkdirState.resolution
          : await resolveExecWorkdir({
              host,
              workdir: params.workdir,
              defaultCwd: defaults?.cwd,
              nodeCwd: defaults?.nodeCwd,
              sandbox,
            });
      if (workdirResolution.kind === "unavailable") {
        return buildUnavailableWorkdirResult({
          cwd: workdirResolution.requestedCwd,
          startedAt,
          warningText: warnings.join("\n"),
        });
      }
      if (workdirResolution.kind === "sandbox") {
        workdir = workdirResolution.hostCwd;
        containerWorkdir = workdirResolution.containerCwd;
        scriptPreflightCwd = workdirResolution.scriptPreflightCwd;
        if (sandbox?.discardPreparedWorkdir && sandbox.workdirValidation === "backend") {
          const preparedContainerWorkdir = containerWorkdir;
          discardPreparedSandboxWorkdir = () => {
            sandbox.discardPreparedWorkdir?.(preparedContainerWorkdir);
          };
        }
      } else if (workdirResolution.kind === "local") {
        workdir = workdirResolution.hostCwd;
        scriptPreflightCwd = workdirResolution.hostCwd;
      } else {
        workdir = workdirResolution.remoteCwd;
      }
      if (host === "gateway" && workdir) {
        await rejectUnsafeExecLiveStateSqliteShellCommand(params.command, {
          stateDir: resolveStateDir(),
          workdir,
        });
      }
      let run: ExecProcessHandle;
      let backgroundTask: BackgroundExecTaskHandle | null = null;
      let settledOutcome: ExecProcessOutcome | null = null;
      let effectiveTimeout: number;
      try {
        if (elevatedRequested) {
          logInfo(`exec: elevated command ${truncateMiddle(params.command, 120)}`);
        }
        if (!resolveExecEnvPrepared) {
          params = await requestPreparation.prepareParamsWithResolvedExecEnv(params, {
            hookContext: deferredResolveExecEnvState?.hookContext,
          });
        }

        const resolvedExecEnvState = requestPreparation.getResolvedExecEnvPreparedState(params);
        const storeEnv = await resolveStoreEnv();
        // The proxy is loopback-owned by the Gateway. Sandbox and node hosts
        // cannot use its sentinels, so both sides of the contract stay absent.
        const useSecretEgress = secretEgressEnabled && host === "gateway";
        let secretEgressEnv: Record<string, string> | undefined;
        if (useSecretEgress) {
          if (!defaults?.operationalRunInstance) {
            throw new Error("Secret egress proxy requires an admitted agent run instance");
          }
          secretEgressEnv = registerSecretEgressProxyRun(
            defaults.operationalRunInstance,
            storeEnv.secretEgressBindings ?? [],
          );
        }
        const { env, requestedEnv } = resolvePreparedExecEnvironment({
          execParams: params,
          host,
          sandbox,
          containerWorkdir,
          channelContext: defaults?.channelContext,
          defaultPathPrepend,
          pluginEnv: resolvedExecEnvState?.pluginEnv,
          storeEnv: storeEnv.env,
          storeSecretEnv: useSecretEgress ? storeEnv.secretSentinels : undefined,
          secretEgressEnv,
          warnings,
        });

        if (host === "node") {
          return executeNodeHostCommand({
            command: params.command,
            toolCallId,
            workdir,
            env,
            requestedEnv,
            requestedNode: params.node?.trim(),
            boundNode: defaults?.node?.trim(),
            sessionKey: defaults?.sessionKey,
            sessionId: defaults?.sessionId,
            sessionStore: defaults?.sessionStore,
            bashElevated: elevatedDefaults,
            approvalReviewerDeviceId: defaults?.approvalReviewerDeviceId,
            nonInteractiveApproval: defaults?.nonInteractiveApproval,
            turnSourceChannel: defaults?.messageProvider,
            turnSourceTo: defaults?.currentChannelId,
            turnSourceAccountId: defaults?.accountId,
            turnSourceThreadId: defaults?.currentThreadTs,
            agentId,
            security,
            ask,
            autoReview,
            autoReviewer,
            signal,
            strictInlineEval: defaults?.strictInlineEval,
            commandHighlighting: defaults?.commandHighlighting,
            trigger: defaults?.trigger,
            timeoutSec: params.timeoutSeconds,
            defaultTimeoutSec,
            approvalRunningNoticeMs,
            warnings,
            foregroundWarnings: foregroundFallbackWarning ? [foregroundFallbackWarning] : [],
            notifySessionKey,
            notifyOnExit,
            trustedSafeBinDirs,
          });
        }

        if (!workdir) {
          throw new Error("exec internal error: local execution requires a resolved workdir");
        }

        if (host === "gateway" && !bypassApprovals) {
          const gatewayResult = await processGatewayAllowlist({
            command: params.command,
            workdir,
            env,
            pathPrepend: defaultPathPrepend,
            requestedEnv,
            pty: params.pty === true && !sandbox,
            timeoutSec: params.timeoutSeconds,
            defaultTimeoutSec,
            security,
            ask,
            autoReview,
            autoReviewer,
            signal,
            safeBins,
            safeBinProfiles,
            strictInlineEval: defaults?.strictInlineEval,
            commandHighlighting: defaults?.commandHighlighting,
            trigger: defaults?.trigger,
            agentId,
            sessionKey: defaults?.sessionKey,
            runId: defaults?.runId,
            toolCallId,
            sessionId: defaults?.sessionId,
            sessionStore: defaults?.sessionStore,
            bashElevated: elevatedDefaults,
            approvalReviewerDeviceId: defaults?.approvalReviewerDeviceId,
            nonInteractiveApproval: defaults?.nonInteractiveApproval,
            turnSourceChannel: defaults?.messageProvider,
            turnSourceTo: defaults?.currentChannelId,
            turnSourceAccountId: defaults?.accountId,
            turnSourceThreadId: defaults?.currentThreadTs,
            scopeKey: defaults?.scopeKey,
            approvalFollowupText: defaults?.approvalFollowupText,
            approvalFollowup: defaults?.approvalFollowup,
            approvalFollowupMode: defaults?.approvalFollowupMode,
            warnings,
            notifySessionKey,
            approvalRunningNoticeMs,
            maxOutput,
            pendingMaxOutput,
            trustedSafeBinDirs,
          });
          if (gatewayResult.pendingResult) {
            return gatewayResult.pendingResult;
          }
          if (gatewayResult.deniedResult) {
            return gatewayResult.deniedResult;
          }
          signal?.throwIfAborted();
          execCommandOverride = gatewayResult.execCommandOverride;
          if (gatewayResult.allowWithoutEnforcedCommand) {
            execCommandOverride = undefined;
          }
        }

        // Pending approvals have not started the command. Add fallback warnings only
        // after approval routing proves this call will execute in the foreground.
        if (foregroundFallbackWarning) {
          warnings.push(foregroundFallbackWarning);
        }

        const explicitTimeoutSec = params.timeoutSeconds ?? null;
        effectiveTimeout = explicitTimeoutSec ?? defaultTimeoutSec;
        const usePty = params.pty === true && !sandbox;

        // Preflight: catch a common model failure mode (shell syntax leaking into Python/JS sources)
        // before we execute and burn tokens in cron loops.
        if (scriptPreflightCwd && !shouldSkipExecScriptPreflight({ host, security, ask })) {
          await validateScriptFileForShellBleed({
            command: params.command,
            workdir: scriptPreflightCwd,
          });
        }

        signal?.throwIfAborted();
        run = await runExecProcess({
          command: params.command,
          execCommand: execCommandOverride,
          workdir,
          env,
          pathPrepend: defaultPathPrepend,
          sandbox,
          containerWorkdir,
          usePty,
          warnings,
          maxOutput,
          pendingMaxOutput,
          notifyOnExit,
          notifyOnExitEmptySuccess,
          scopeKey: defaults?.scopeKey,
          sessionKey: notifySessionKey,
          agentId,
          mainKey: defaults?.mainKey,
          sessionScope: defaults?.sessionScope,
          eventRouting: defaults?.eventRouting,
          notifyDeliveryContext,
          timeoutSec: effectiveTimeout,
          onUpdate,
          onSettledBeforeNotify: (outcome) => {
            settledOutcome = outcome;
            finalizeBackgroundExecTask({ handle: backgroundTask, outcome });
          },
        });
        discardPreparedSandboxWorkdir = null;
      } catch (error) {
        discardPreparedSandboxWorkdir?.();
        throw error;
      }

      let yielded = false;
      let yieldTimer: NodeJS.Timeout | null = null;
      let registeredAbortSignal: AbortSignal | null = null;
      let toolAborted = false;

      // Tool-call abort should not kill backgrounded sessions; timeouts still must.
      const onAbortSignal = () => {
        // Immediately suppress onUpdate calls so that any late stdout/stderr
        // from the still-running process cannot push a rejected Promise into
        // agent runtime's updateEvents after the agent run has ended (#62520).
        // Intentionally placed *before* the yielded/backgrounded guard: the
        // agent run is ending regardless, so no consumer exists for further
        // tool_execution_update events even for backgrounded sessions (which
        // retrieve output via process poll/log instead of onUpdate callbacks).
        run.disableUpdates();
        if (yielded || run.session.backgrounded) {
          return;
        }
        // Cancellation must win over foreground-to-background promotion while
        // the child settles; detached background sessions keep their owner.
        toolAborted = true;
        if (yieldTimer) {
          clearTimeout(yieldTimer);
          yieldTimer = null;
        }
        run.kill();
      };

      const cleanupToolRunListeners = () => {
        if (registeredAbortSignal) {
          registeredAbortSignal.removeEventListener("abort", onAbortSignal);
          registeredAbortSignal = null;
        }
        if (yieldTimer) {
          clearTimeout(yieldTimer);
          yieldTimer = null;
        }
      };

      if (signal?.aborted) {
        onAbortSignal();
      } else if (signal) {
        signal.addEventListener("abort", onAbortSignal, { once: true });
        registeredAbortSignal = signal;
      }

      return new Promise<AgentToolResult<ExecToolDetails>>((resolve, reject) => {
        const rejectIfAborted = () => {
          if (!toolAborted) {
            return false;
          }
          reject(createAbortError("Tool execution was aborted", { cause: signal?.reason }));
          return true;
        };

        const resolveRunning = () => {
          cleanupToolRunListeners();
          resolve({
            content: [
              {
                type: "text",
                text: `${getWarningText()}Command still running (session ${run.session.id}, pid ${
                  run.session.pid ?? "n/a"
                }). Use process (list/poll/log/write/send-keys/submit/paste/kill/clear/remove) for follow-up.`,
              },
            ],
            details: {
              status: "running",
              sessionId: run.session.id,
              pid: run.session.pid ?? undefined,
              startedAt: run.startedAt,
              cwd: run.session.cwd,
              tail: run.session.tail,
            },
          });
        };

        const onYieldNow = () => {
          if (yielded || toolAborted) {
            return;
          }
          if (settledOutcome) {
            cleanupToolRunListeners();
            resolve(
              buildExecForegroundResult({
                outcome: settledOutcome,
                cwd: run.session.cwd,
                warningText: getWarningText(),
                aggregateOutputDropped:
                  run.session.totalOutputChars > run.session.aggregated.length,
              }),
            );
            return;
          }
          yielded = true;
          markBackgrounded(run.session);
          // Only the guarded yield transition owns task registration. A process
          // that settles before this timer fires must stay out of the task ledger.
          backgroundTask = createBackgroundExecTask({
            processSessionId: run.session.id,
            sessionKey: notifySessionKey,
            agentId,
            startedAt: run.startedAt,
          });
          resolveRunning();
        };

        if (!toolAborted && allowBackground && yieldWindow !== null) {
          if (yieldWindow === 0) {
            onYieldNow();
          } else {
            yieldTimer = setTimeout(() => {
              onYieldNow();
            }, yieldWindow);
          }
        }

        run.promise
          .then((outcome) => {
            cleanupToolRunListeners();
            if (rejectIfAborted() || yielded || run.session.backgrounded) {
              return;
            }
            resolve(
              buildExecForegroundResult({
                outcome,
                cwd: run.session.cwd,
                warningText: getWarningText(),
                aggregateOutputDropped:
                  run.session.totalOutputChars > run.session.aggregated.length,
              }),
            );
          })
          .catch((err: unknown) => {
            cleanupToolRunListeners();
            if (rejectIfAborted() || yielded || run.session.backgrounded) {
              return;
            }
            reject(err as Error);
          });
      });
    },
  };
}

/** Default exec tool instance used by agent tool registries. */
export const execTool = createExecTool();
