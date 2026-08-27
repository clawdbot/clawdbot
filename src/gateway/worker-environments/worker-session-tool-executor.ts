import { isDeepStrictEqual } from "node:util";
import type {
  WorkerGitHubPublishParams,
  WorkerSessionsSendParams,
  WorkerSessionsSpawnParams,
  WorkerSessionToolResult,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { buildSubagentExecutionSessionSpawnContext } from "../../agents/subagents/spawn/subagent-spawn-execution-identity.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import {
  callAgentToolGatewayRequest,
  callInProcessGatewayToolWithCreation,
  type InProcessGatewayCaller,
  withAgentToolGatewayRuntimeIdentity,
} from "../../agents/tools/in-process-gateway.js";
import { runWithScopedSessionAccess } from "../../agents/tools/scoped-session-access.js";
import { createSessionsSendTool } from "../../agents/tools/sessions-send-tool.js";
import { createSessionsSpawnTool } from "../../agents/tools/sessions-spawn-tool.js";
import { jsonResult } from "../../agents/tools/tool-results.js";
import { DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH } from "../../config/agent-limits.js";
import { getRuntimeConfig } from "../../config/config.js";
import { sha256Base64Url, sha256HexPrefixCore } from "../../infra/crypto-digest.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { WORKER_TOOL_NAMES } from "../../worker/tool-authority.js";
import type { GitHubPublicationCoordinator } from "../github-publication.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import {
  getWorkerTurnExecutionIdentityCapability,
  type WorkerTurnExecutionIdentity,
} from "./placement-turn-claim-events.js";
import type { WorkerPlacementDispatchContract } from "./service-contract.js";
import type { WorkerEnvironmentService } from "./service.js";
import {
  createWorkerPortalToolExecutor,
  type WorkerPortalToolExecutorDependencies,
  type WorkerPortalToolRequest,
} from "./worker-portal-tool-executor.js";
import {
  serializeWorkerSessionToolResult as serializeResult,
  workerSessionToolErrorResult as errorResult,
} from "./worker-session-tool-result.js";
import {
  assertWorkerSessionToolChild as assertExactChild,
  resolveWorkerSessionToolSource as exactSource,
  resolveWorkerSessionToolTarget as exactAuthorizedTarget,
  workerSessionRelationKey as relationKey,
  type WorkerSessionToolSource as ExactSource,
  type WorkerSessionToolTarget as ExactTarget,
} from "./worker-session-tool-topology.js";

type WorkerSessionToolRequest =
  | WorkerPortalToolRequest
  | ({ identity: WorkerConnectionIdentity; signal?: AbortSignal } & (
      | { toolName: "sessions_spawn"; request: WorkerSessionsSpawnParams }
      | { toolName: "sessions_send"; request: WorkerSessionsSendParams }
      | { toolName: "github_publish"; request: WorkerGitHubPublishParams }
    ));

class WorkerSessionToolOutcomeUnknownError extends Error {
  constructor(cause: unknown) {
    super("Worker session operation outcome is unknown; it was not replayed", { cause });
    this.name = "WorkerSessionToolOutcomeUnknownError";
  }
}

function computeRequestDigest(value: unknown): string {
  return sha256Base64Url(`openclaw.worker-session-tool-request.v1\0${JSON.stringify(value)}`);
}

function operationKey(operationSeed: string, purpose: string): string {
  return sha256Base64Url(`openclaw.worker-session-tool-operation.v1\0${operationSeed}\0${purpose}`);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

function childSessionKey(params: { operationSeed: string; targetAgentId: string }): string {
  const suffix = sha256HexPrefixCore(
    `openclaw.worker-session-tool-operation.v1\0${params.operationSeed}\0child-session`,
    32,
  );
  return `agent:${params.targetAgentId}:dashboard:cloud-${suffix}`;
}

export function createWorkerSessionToolExecutor(params: {
  placements: WorkerSessionPlacementStore;
  environments: Pick<WorkerEnvironmentService, "get">;
  dispatchChild: WorkerPlacementDispatchContract["dispatch"];
  githubPublication: Pick<GitHubPublicationCoordinator, "requestForClaim">;
  portals: WorkerPortalToolExecutorDependencies["portals"];
}) {
  const inFlight = new Map<string, Promise<string>>();
  const executePortal = createWorkerPortalToolExecutor(params);

  const spawn = async (operation: {
    source: ExactSource;
    identity: WorkerConnectionIdentity;
    request: WorkerSessionsSpawnParams;
    operationSeed: string;
    childSessionKey: string;
    signal?: AbortSignal;
  }) => {
    throwIfAborted(operation.signal);
    const sourceEnvironment = params.environments.get(operation.identity.environmentId);
    if (
      !sourceEnvironment ||
      sourceEnvironment.state !== "attached" ||
      sourceEnvironment.ownerEpoch !== operation.identity.ownerEpoch ||
      sourceEnvironment.attachedSessionIds.length !== 1 ||
      sourceEnvironment.attachedSessionIds[0] !== operation.source.sessionId
    ) {
      throw new Error("Worker source environment changed before child spawn");
    }
    const targetAgentId = normalizeAgentId(operation.request.agentId ?? operation.source.agentId);
    const authorizedTools = WORKER_TOOL_NAMES.filter((name) =>
      params.placements.isWorkerTurnToolAuthorized(operation.source.turnClaim, name),
    );
    const lineageCapability = getWorkerTurnExecutionIdentityCapability(
      params.placements,
      operation.source.turnClaim,
    );
    let workerIdentity: WorkerTurnExecutionIdentity | undefined;
    const gatewayCall: InProcessGatewayCaller = async <T = Record<string, unknown>>(
      method: string,
      requestParams: Record<string, unknown>,
    ): Promise<T> => {
      if (method !== "sessions.create") {
        return await callAgentToolGatewayRequest<T>({
          method,
          params: requestParams,
          ...(operation.signal ? { signal: operation.signal } : {}),
          timeoutMs: null,
        });
      }
      throwIfAborted(operation.signal);
      exactSource({ identity: operation.identity, placements: params.placements });
      let loaded = loadGatewaySessionEntryReadOnly(operation.childSessionKey, {
        agentId: targetAgentId,
      });
      let createResponse: Record<string, unknown>;
      let creationAttempted = false;
      if (loaded.entry?.sessionId) {
        const parent =
          relationKey(loaded.entry.parentSessionKey) ?? relationKey(loaded.entry.spawnedBy);
        const parentSessionId = relationKey(loaded.entry.parentSessionId);
        if (
          loaded.canonicalKey !== operation.childSessionKey ||
          parent !== operation.source.sessionKey ||
          parentSessionId !== operation.source.sessionId
        ) {
          throw new Error("Cloud child idempotency key is already owned by another session");
        }
        createResponse = {
          ok: true,
          key: loaded.canonicalKey,
          sessionId: loaded.entry.sessionId,
          entry: loaded.entry,
        };
      } else {
        const createParams: Record<string, unknown> = {
          ...requestParams,
          ...(operation.source.entry.permissionMode
            ? { permissionMode: operation.source.entry.permissionMode }
            : {}),
          key: operation.childSessionKey,
        };
        delete createParams.task;
        creationAttempted = true;
        try {
          createResponse = await callInProcessGatewayToolWithCreation(
            "sessions.create",
            createParams,
            {
              via: "spawn",
              actor: { type: "agent", id: operation.source.agentId },
              requesterSessionKey: operation.source.sessionKey,
              inheritedToolPolicy: { version: 1, allow: authorizedTools, deny: [] },
            },
            {
              ...(operation.signal ? { signal: operation.signal } : {}),
              timeoutMs: null,
            },
          );
        } catch (error) {
          loaded = loadGatewaySessionEntryReadOnly(operation.childSessionKey, {
            agentId: targetAgentId,
          });
          if (!loaded.entry?.sessionId) {
            throw error;
          }
          createResponse = {
            ok: true,
            key: loaded.canonicalKey,
            sessionId: loaded.entry.sessionId,
            entry: loaded.entry,
          };
        }
        loaded = loadGatewaySessionEntryReadOnly(operation.childSessionKey, {
          agentId: targetAgentId,
        });
      }
      const childSessionId = loaded.entry?.sessionId;
      if (!childSessionId) {
        const error = new Error("Cloud child session creation did not persist an incarnation");
        throw creationAttempted ? new WorkerSessionToolOutcomeUnknownError(error) : error;
      }
      try {
        assertExactChild({
          childSessionKey: operation.childSessionKey,
          childSessionId,
          sourceSessionKey: operation.source.sessionKey,
          sourceSessionId: operation.source.sessionId,
          targetAgentId,
        });
      } catch (error) {
        if (creationAttempted) {
          throw new WorkerSessionToolOutcomeUnknownError(error);
        }
        throw error;
      }
      try {
        const assertActiveChildPlacement = () => {
          const placement = params.placements.get(childSessionId);
          if (placement?.state !== "active" || placement.sessionKey !== operation.childSessionKey) {
            throw new Error("Cloud child placement did not become active");
          }
          const environment = params.environments.get(placement.environmentId);
          if (
            environment?.state !== "attached" ||
            environment.ownerEpoch !== placement.activeOwnerEpoch ||
            environment.attachedSessionIds.length !== 1 ||
            environment.attachedSessionIds[0] !== childSessionId ||
            environment.profileId !== sourceEnvironment.profileId ||
            environment.providerId !== sourceEnvironment.providerId ||
            !isDeepStrictEqual(environment.profileSnapshot, sourceEnvironment.profileSnapshot)
          ) {
            throw new Error("Cloud child placement does not match its parent profile");
          }
        };
        const childPlacement = params.placements.get(childSessionId);
        throwIfAborted(operation.signal);
        exactSource({ identity: operation.identity, placements: params.placements });
        if (childPlacement?.state !== "active") {
          try {
            await params.dispatchChild({
              sessionId: childSessionId,
              sessionKey: operation.childSessionKey,
              agentId: targetAgentId,
              profileId: sourceEnvironment.profileId,
              executionMode: "worker-turn",
              inheritedProfile: {
                providerId: sourceEnvironment.providerId,
                profileSnapshot: sourceEnvironment.profileSnapshot,
              },
            });
          } catch (error) {
            try {
              assertActiveChildPlacement();
            } catch {
              throw new WorkerSessionToolOutcomeUnknownError(error);
            }
          }
        }
        assertActiveChildPlacement();
        exactSource({ identity: operation.identity, placements: params.placements });
        throwIfAborted(operation.signal);
        assertExactChild({
          childSessionKey: operation.childSessionKey,
          childSessionId,
          sourceSessionKey: operation.source.sessionKey,
          sourceSessionId: operation.source.sessionId,
          targetAgentId,
        });
        const childRunId = operationKey(operation.operationSeed, "initial-task");
        const config = getRuntimeConfig();
        const gatewayCaller = getGatewayToolCallerIdentity();
        const sessionSpawnContext = lineageCapability
          ? buildSubagentExecutionSessionSpawnContext({
              enabled: true,
              backend: "subagent",
              parentAgentId: operation.source.agentId,
              requesterRef: operation.source.sessionKey,
              controllerRef: operation.source.sessionKey,
              depth: (operation.source.entry.spawnDepth ?? 0) + 1,
              maxDepth:
                config.agents?.defaults?.subagents?.maxSpawnDepth ??
                DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH,
              targetAgentId,
              sandbox: "inherit",
              inheritedToolAllowlist: authorizedTools,
              inheritedToolDenylist: [],
            })
          : undefined;
        const run = await runWithScopedSessionAccess({
          cfg: config,
          expectedSessionId: childSessionId,
          targetSessionKey: operation.childSessionKey,
          ...(operation.signal ? { signal: operation.signal } : {}),
          run: async () => {
            let sendResult: Record<string, unknown> | undefined;
            for (let attempt = 0; attempt < 2; attempt += 1) {
              try {
                throwIfAborted(operation.signal);
                exactSource({ identity: operation.identity, placements: params.placements });
                assertExactChild({
                  childSessionKey: operation.childSessionKey,
                  childSessionId,
                  sourceSessionKey: operation.source.sessionKey,
                  sourceSessionId: operation.source.sessionId,
                  targetAgentId,
                });
                assertActiveChildPlacement();
                const request = {
                  method: "agent",
                  agentRunTracking: "native_subagent",
                  params: {
                    sessionKey: operation.childSessionKey,
                    sessionId: childSessionId,
                    expectedExistingSessionId: childSessionId,
                    message: operation.request.task,
                    deliver: false,
                    sessionEffects: "visible",
                    // A lost response is replayed with this same downstream key;
                    // the child turn is never started under a fresh identity.
                    idempotencyKey: `worker-session-spawn:${childRunId}`,
                  },
                  ...(operation.signal ? { signal: operation.signal } : {}),
                  timeoutMs: null,
                } as const;
                sendResult =
                  lineageCapability && workerIdentity
                    ? await lineageCapability.run(async (identity) => {
                        if (
                          identity !== workerIdentity ||
                          gatewayCaller?.agentId !== identity.agentId ||
                          gatewayCaller.sessionKey !== identity.sessionKey ||
                          gatewayCaller.operationalRunInstance !==
                            identity.operationalRunInstance ||
                          gatewayCaller.executionIdentityToken !==
                            identity.executionIdentityToken ||
                          gatewayCaller.workerTurnClaim !== identity.turnClaim
                        ) {
                          throw new Error("worker child admission identity changed");
                        }
                        return await callAgentToolGatewayRequest(
                          withAgentToolGatewayRuntimeIdentity(request, {
                            kind: "agentRuntime",
                            agentId: identity.agentId,
                            sessionKey: identity.sessionKey,
                            operationalRunInstance: identity.operationalRunInstance,
                            delegatedAuthority: {
                              kind: "worker",
                              ...identity.delegatedAuthority,
                              turnClaim: identity.turnClaim,
                            },
                            executionIdentity: identity.executionIdentityToken,
                            sessionSpawnContext,
                          }),
                        );
                      })
                    : await callAgentToolGatewayRequest(request);
                break;
              } catch (error) {
                if (attempt === 1) {
                  throw new WorkerSessionToolOutcomeUnknownError(error);
                }
              }
            }
            if (!sendResult) {
              throw new WorkerSessionToolOutcomeUnknownError(
                new Error("Cloud child initial task did not return a result"),
              );
            }
            return sendResult;
          },
        });
        const runId = typeof run.runId === "string" ? run.runId : undefined;
        return {
          ...createResponse,
          ...run,
          runStarted: Boolean(runId),
          ...(runId ? { runId } : {}),
        } as T;
      } catch (error) {
        throw error instanceof WorkerSessionToolOutcomeUnknownError
          ? error
          : new WorkerSessionToolOutcomeUnknownError(error);
      }
    };
    const tool = createSessionsSpawnTool({
      agentSessionKey: operation.source.sessionKey,
      requesterTurnRunId: operation.identity.runId ?? undefined,
      requesterAgentIdOverride: operation.source.agentId,
      inheritedToolAllowlist: authorizedTools,
      inheritedToolDenylist: [],
      callGateway: gatewayCall,
      expectedParentSessionId: operation.source.sessionId,
      ...(operation.signal ? { signal: operation.signal } : {}),
    });
    const executeSpawn = () =>
      tool.execute(operation.request.toolCallId, {
        task: operation.request.task,
        ...(operation.request.label ? { label: operation.request.label } : {}),
        ...(operation.request.agentId ? { agentId: operation.request.agentId } : {}),
        ...(operation.request.model ? { model: operation.request.model } : {}),
        ...(operation.request.runTimeoutSeconds === undefined
          ? {}
          : { runTimeoutSeconds: operation.request.runTimeoutSeconds }),
        expectsCompletionMessage: false,
        visible: true,
        worktree: true,
      });
    return lineageCapability
      ? await lineageCapability.run(async (identity) => {
          workerIdentity = identity;
          try {
            return await withGatewayToolCallerIdentity(
              {
                agentId: identity.agentId,
                sessionKey: identity.sessionKey,
                operationalRunInstance: identity.operationalRunInstance,
                executionIdentityToken: identity.executionIdentityToken,
                receiptAuthority: identity.receiptAuthority,
                workerTurnClaim: identity.turnClaim,
                workerTurnExecutionIdentityCapability: lineageCapability,
              },
              executeSpawn,
            );
          } finally {
            workerIdentity = undefined;
          }
        })
      : await executeSpawn();
  };

  const send = async (operation: {
    source: ExactSource;
    identity: WorkerConnectionIdentity;
    target: ExactTarget;
    request: WorkerSessionsSendParams;
    idempotencyKey: string;
    signal?: AbortSignal;
  }) => {
    throwIfAborted(operation.signal);
    exactSource({ identity: operation.identity, placements: params.placements });
    const config = getRuntimeConfig();
    const executeFencedSend = async () => {
      const assertCurrentTarget = () => {
        const target = exactAuthorizedTarget({
          source: operation.source,
          requestedSessionKey: operation.request.sessionKey,
          placements: params.placements,
        });
        if (
          target.sessionId !== operation.target.sessionId ||
          target.topologyParent?.sessionKey !== operation.target.topologyParent?.sessionKey ||
          target.topologyParent?.sessionId !== operation.target.topologyParent?.sessionId
        ) {
          throw new Error("Worker sessions_send target incarnation changed");
        }
      };
      assertCurrentTarget();
      const tool = createSessionsSendTool({
        agentSessionKey: operation.source.sessionKey,
        expectedTargetSessionId: operation.target.sessionId,
        idempotencyKey: operation.idempotencyKey,
        config,
        ...(operation.signal ? { signal: operation.signal } : {}),
        callGateway: (request) =>
          callAgentToolGatewayRequest({
            ...request,
            ...(operation.signal ? { signal: operation.signal } : {}),
          }),
      });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          throwIfAborted(operation.signal);
          exactSource({ identity: operation.identity, placements: params.placements });
          assertCurrentTarget();
          return await tool.execute(operation.request.toolCallId, {
            sessionKey: operation.target.sessionKey,
            message: operation.request.message,
            ...(operation.request.timeoutSeconds === undefined
              ? {}
              : { timeoutSeconds: operation.request.timeoutSeconds }),
          });
        } catch (error) {
          if (attempt === 1) {
            throw new WorkerSessionToolOutcomeUnknownError(error);
          }
        }
      }
      throw new WorkerSessionToolOutcomeUnknownError(
        new Error("Worker sessions_send did not return a result"),
      );
    };
    const topologyParent = operation.target.topologyParent;
    if (!topologyParent) {
      return await executeFencedSend();
    }
    // Sibling authority exists only while the exact shared parent exists. Hold
    // that third incarnation through target admission and the message effect.
    return await runWithScopedSessionAccess({
      cfg: config,
      expectedSessionId: topologyParent.sessionId,
      targetSessionKey: topologyParent.sessionKey,
      ...(operation.signal ? { signal: operation.signal } : {}),
      run: executeFencedSend,
    });
  };

  return async (request: WorkerSessionToolRequest): Promise<WorkerSessionToolResult> => {
    const source = exactSource({ identity: request.identity, placements: params.placements });
    if (request.toolName === "portal") {
      return await executePortal(request);
    }
    if (request.toolName === "github_publish") {
      const assertPublicationAuthority = () => {
        const current = exactSource({ identity: request.identity, placements: params.placements });
        if (!params.placements.isWorkerTurnToolAuthorized(current.turnClaim, request.toolName)) {
          throw new Error("Worker session tool authority changed");
        }
      };
      assertPublicationAuthority();
      throwIfAborted(request.signal);
      const publication = await params.githubPublication.requestForClaim({
        claim: source.turnClaim,
        sessionKey: source.sessionKey,
        agentId: source.agentId,
        idempotencyKey: request.request.toolCallId,
        ...(request.request.title ? { title: request.request.title } : {}),
        ...(request.request.body ? { body: request.request.body } : {}),
        assertCurrent: assertPublicationAuthority,
      });
      assertPublicationAuthority();
      return { resultJson: serializeResult(jsonResult(publication)) };
    }
    const requestDigest = computeRequestDigest(
      request.toolName === "sessions_spawn"
        ? {
            toolName: request.toolName,
            sourceSessionId: source.sessionId,
            task: request.request.task,
            label: request.request.label ?? null,
            agentId: request.request.agentId ?? null,
            model: request.request.model ?? null,
            runTimeoutSeconds: request.request.runTimeoutSeconds ?? null,
          }
        : {
            toolName: request.toolName,
            sourceSessionId: source.sessionId,
            sessionKey: request.request.sessionKey,
            message: request.request.message,
            timeoutSeconds: request.request.timeoutSeconds ?? null,
          },
    );
    const started = params.placements.beginWorkerSessionToolOperation({
      claim: source.turnClaim,
      toolName: request.toolName,
      toolCallId: request.request.toolCallId,
      requestDigest,
    });
    if (started.kind === "completed") {
      return { resultJson: started.resultJson };
    }
    if (started.kind === "unknown") {
      return {
        resultJson: serializeResult(
          errorResult(new Error("The prior operation outcome is unknown; it was not replayed")),
        ),
      };
    }
    if (started.kind === "conflict") {
      return {
        resultJson: serializeResult(errorResult(new Error("Worker tool call id was reused"))),
      };
    }
    if (started.kind === "capacity") {
      return {
        resultJson: serializeResult(
          errorResult(new Error("Too many worker session operations are already in progress")),
        ),
      };
    }
    if (started.kind === "unauthorized") {
      throw new Error("Worker session tool authority changed");
    }
    const sourceClaimId = source.turnClaim.claimId;
    const inFlightKey = `${source.sessionId}\0${sourceClaimId}\0${request.request.toolCallId}`;
    if (started.kind === "in-progress") {
      const existing = inFlight.get(inFlightKey);
      return {
        resultJson:
          (existing ? await existing : undefined) ??
          serializeResult(
            errorResult(new Error("Worker session operation is already in progress")),
          ),
      };
    }
    const operation = (async () => {
      let result: unknown;
      let failed = false;
      try {
        const target =
          request.toolName === "sessions_send"
            ? exactAuthorizedTarget({
                source,
                requestedSessionKey: request.request.sessionKey,
                placements: params.placements,
              })
            : undefined;
        let childKey = started.childSessionKey;
        if (request.toolName === "sessions_spawn" && !childKey) {
          const targetAgentId = normalizeAgentId(request.request.agentId ?? source.agentId);
          childKey = childSessionKey({
            operationSeed: started.operationSeed,
            targetAgentId,
          });
          if (
            !params.placements.bindWorkerSessionToolOperationChild({
              sourceSessionId: source.sessionId,
              sourceClaimId,
              toolCallId: request.request.toolCallId,
              requestDigest,
              childSessionKey: childKey,
            })
          ) {
            throw new Error("Worker child spawn operation changed before execution");
          }
        }
        result =
          request.toolName === "sessions_spawn"
            ? await spawn({
                source,
                identity: request.identity,
                request: request.request,
                operationSeed: started.operationSeed,
                childSessionKey: childKey!,
                ...(request.signal ? { signal: request.signal } : {}),
              })
            : await send({
                source,
                identity: request.identity,
                target: target!,
                request: request.request,
                idempotencyKey: `worker-session-send:${operationKey(
                  started.operationSeed,
                  "target-send",
                )}`,
                ...(request.signal ? { signal: request.signal } : {}),
              });
      } catch (error) {
        if (error instanceof WorkerSessionToolOutcomeUnknownError || request.signal?.aborted) {
          if (
            !params.placements.abandonWorkerSessionToolOperation({
              sourceSessionId: source.sessionId,
              sourceClaimId,
              toolCallId: request.request.toolCallId,
              requestDigest,
            })
          ) {
            return serializeResult(
              errorResult(new Error("Worker session operation lost ownership")),
            );
          }
          return serializeResult(
            errorResult(
              error instanceof WorkerSessionToolOutcomeUnknownError
                ? error
                : new Error("Worker session operation outcome is unknown after cancellation"),
            ),
          );
        }
        failed = true;
        result = errorResult(error);
      }
      const resultJson = serializeResult(result);
      if (
        !params.placements.completeWorkerSessionToolOperation({
          sourceSessionId: source.sessionId,
          sourceClaimId,
          toolCallId: request.request.toolCallId,
          requestDigest,
          resultJson,
          failed,
        })
      ) {
        return serializeResult(errorResult(new Error("Worker session operation lost ownership")));
      }
      return resultJson;
    })();
    inFlight.set(inFlightKey, operation);
    try {
      return { resultJson: await operation };
    } finally {
      if (inFlight.get(inFlightKey) === operation) {
        inFlight.delete(inFlightKey);
      }
    }
  };
}
