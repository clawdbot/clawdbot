import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORKER_COMPUTER_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-computer.js";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { runEmbeddedAgentEntry } from "../../agents/embedded-agent-runner/run-entry.js";
import { abortable } from "../../agents/embedded-agent-runner/run/abortable.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import { FailoverError, resolveModelFallbackError } from "../../agents/failover-error.js";
import { runWithModelFallback } from "../../agents/model-fallback-runner.js";
import { createAgentRunDirectAbortError } from "../../agents/run-termination.js";
import { installSessionPlacementAdmissionProvider } from "../../agents/session-placement-admission.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  attachErrorDiagnostic,
  formatErrorMessageForDisplay,
} from "../../infra/error-diagnostics.js";
import { saveMediaBuffer } from "../../media/store.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import type { WorkerGitHubLaunchBinding } from "../../worker/launch-descriptor.js";
import type { PreparedWorkerComputer } from "./computer-transport.js";
import * as skillTransfer from "./skill-resource-transfer.js";
import { WorkerRunnerCapacityError, type WorkerTunnelHandle } from "./tunnel-contract.js";
import {
  ENVIRONMENT_ID,
  MANIFEST_REF,
  root,
  sessionTarget,
  withWorkerCompactionAdoption,
  type WorkerTurnEnvironmentService,
  OWNER_EPOCH,
  SESSION_ID,
  SESSION_KEY,
  attachedEnvironment,
  credential,
  cleanupWorkerTurnLauncherTest,
  computerDescriptor,
  createWorkerSessionTurnPlacementProvider,
  measureLaunchTurn,
  placements,
  seedActivePlacement,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
} from "./worker-turn-launcher.test-support.js";

const prepareGitHubBinding = vi.hoisted(() => vi.fn());
vi.mock("./worker-github-binding.js", () => ({
  prepareWorkerGitHubBinding: prepareGitHubBinding,
}));

describe("worker launch capabilities", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  beforeEach(() => {
    prepareGitHubBinding.mockReset().mockResolvedValue(undefined);
  });
  afterEach(cleanupWorkerTurnLauncherTest);

  it.each([true, false])(
    "carries only an available GitHub identity in the launch envelope (%s)",
    async (available) => {
      seedActivePlacement();
      const github: WorkerGitHubLaunchBinding = {
        token: "synthetic-turn-bound-github-token",
        login: "shared-bot",
        branch: "openclaw/session-branch",
        remoteUrl: "https://github.com/owner/repo.git",
        gitAuthor: { name: "Shared Bot", email: "shared@example.test" },
      };
      prepareGitHubBinding.mockResolvedValue(available ? github : undefined);
      const launchTurn = vi.fn<NonNullable<WorkerTunnelHandle["launchTurn"]>>(async ({ plan }) => {
        if (available) {
          expect(plan.assignment.github).toEqual(github);
        } else {
          expect(plan.assignment).not.toHaveProperty("github");
        }
        throw new WorkerRunnerCapacityError();
      });
      const tunnel: WorkerTunnelHandle = {
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        launchTurn,
        measureLaunchTurn,
        stageAttachments: vi.fn(),
        runWorkspaceCommand: vi.fn(),
        quiesceWorkspace: vi.fn(),
        syncWorkspace: vi.fn(),
        reconcileWorkspace: vi.fn(),
        stop: vi.fn(async () => {}),
      };
      const environments = {
        ...unusedEnvironments(),
        get: vi.fn(() => attachedEnvironment()),
        acquireTurnCredential: vi.fn(async () => credential()),
        startTunnel: vi.fn(async () => tunnel),
      };
      const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
      await expect(
        provider.executeTurn(
          { sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main", runId: "run-github" },
          turn("run-github"),
          vi.fn(),
        ),
      ).rejects.toBeInstanceOf(WorkerRunnerCapacityError);
      expect(launchTurn).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { missingFeature: undefined, modelHasVision: undefined, allowed: true },
    { missingFeature: undefined, modelHasVision: true, allowed: true },
    { missingFeature: undefined, modelHasVision: false, allowed: false },
    { missingFeature: WORKER_COMPUTER_PROTOCOL_FEATURE, modelHasVision: true, allowed: false },
  ])(
    "grants computer with negotiated features and model vision (missing: $missingFeature, vision: $modelHasVision)",
    async ({ missingFeature, modelHasVision, allowed }) => {
      seedActivePlacement();
      const environment = attachedEnvironment();
      if (!missingFeature) {
        environment.bootstrapReceipt!.protocolFeatures.push(WORKER_COMPUTER_PROTOCOL_FEATURE);
      }
      const computer = computerDescriptor("worker-desktop");
      const image = {
        type: "image" as const,
        data: createSolidPngBuffer(2, 2, { r: 255, g: 0, b: 0 }).toString("base64"),
        mimeType: "image/png",
      };
      const bind = vi.fn(() => ({ resolveNode: async () => computer, invoke: vi.fn() }));
      const prepareComputer = vi.fn(async () => ({
        descriptor: computer,
        bind,
        close: vi.fn(async () => {}),
      }));
      const launchTurn = vi.fn<NonNullable<WorkerTunnelHandle["launchTurn"]>>(async ({ plan }) => {
        expect(plan.assignment.computer).toEqual(allowed ? computer : undefined);
        const prompt = plan.assignment.prompt;
        const images = Array.isArray(prompt) ? prompt.filter((part) => part.type === "image") : [];
        expect(images).toEqual(modelHasVision === true ? [image] : []);
        expect(plan.assignment.toolAuthority.allowedToolNames.includes("computer")).toBe(allowed);
        throw new WorkerRunnerCapacityError();
      });
      const tunnel: WorkerTunnelHandle = {
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        launchTurn,
        measureLaunchTurn,
        stageAttachments: vi.fn(async () => {}),
        runWorkspaceCommand: vi.fn(),
        quiesceWorkspace: vi.fn(),
        syncWorkspace: vi.fn(),
        reconcileWorkspace: vi.fn(),
        stop: vi.fn(async () => {}),
      };
      const environments = {
        ...unusedEnvironments(),
        get: vi.fn(() => environment),
        acquireTurnCredential: vi.fn(async () => credential()),
        startTunnel: vi.fn(async () => tunnel),
        prepareComputer,
      };
      const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
      await expect(
        provider.executeTurn(
          {
            sessionId: SESSION_ID,
            sessionKey: SESSION_KEY,
            agentId: "main",
            runId: "run-computer",
          },
          { ...turn("run-computer"), toolsAllow: ["computer"], modelHasVision, images: [image] },
          async () => ({ meta: { durationMs: 1 } }),
        ),
      ).rejects.toBeInstanceOf(WorkerRunnerCapacityError);
      expect(launchTurn).toHaveBeenCalledOnce();
      expect(tunnel.stageAttachments).toHaveBeenCalledTimes(modelHasVision === true ? 1 : 0);
      expect(prepareComputer).toHaveBeenCalledTimes(allowed ? 1 : 0);
      expect(bind).toHaveBeenCalledTimes(allowed ? 1 : 0);
    },
  );

  it.each<{
    label: string;
    nodeDeviceId?: string;
    providerId: string;
    closeFails: boolean;
    primary?:
      | "provider"
      | "overload"
      | "http-507"
      | "abort"
      | "timeout"
      | "returned"
      | "returned-abort"
      | "returned-timeout"
      | "returned-success";
    pauseSkillCleanup?: boolean;
  }>([
    { label: "SSH", providerId: "fake", closeFails: false },
    {
      label: "paired-device",
      nodeDeviceId: "paired-node-1",
      providerId: "device",
      closeFails: false,
    },
    { label: "cloud-node", nodeDeviceId: "cloud-node-1", providerId: "crabbox", closeFails: false },
    { label: "cloud-node", nodeDeviceId: "cloud-node-1", providerId: "crabbox", closeFails: true },
    {
      label: "paused skill cleanup",
      nodeDeviceId: "paired-node-1",
      providerId: "device",
      closeFails: false,
      pauseSkillCleanup: true,
    },
    ...(
      [
        "provider",
        "overload",
        "http-507",
        "abort",
        "timeout",
        "returned",
        "returned-abort",
        "returned-timeout",
        "returned-success",
      ] as const
    ).flatMap((primary) =>
      [false, true].map((closeFails) => ({
        label: primary,
        nodeDeviceId: "paired-node-1",
        providerId: "device",
        primary,
        closeFails,
      })),
    ),
  ])(
    "settles $label remote-exec output and restores attachment prompts before cleanup (close fails: $closeFails)",
    async ({ nodeDeviceId, providerId, closeFails, primary, pauseSkillCleanup }) => {
      const returnedInterruption = primary === "returned-abort" || primary === "returned-timeout";
      const localResult: EmbeddedAgentRunResult = {
        payloads: [
          {
            text: primary === "returned" ? "recorded primary failure" : "local remote reply",
            ...(primary === "returned" ? { isError: true } : {}),
          },
        ],
        ...(returnedInterruption || primary === "returned-success"
          ? { didSendViaMessagingTool: true, messagingToolSentTexts: ["already delivered"] }
          : {}),
        meta: {
          durationMs: 17,
          ...(primary === "returned"
            ? {
                error: {
                  kind: "incomplete_turn",
                  message: "recorded primary failure",
                  fallbackSafe: true,
                },
                replayInvalid: false,
                livenessState: "blocked",
                toolSummary: { calls: 1, tools: ["computer"], failures: 1 },
              }
            : {}),
          ...(returnedInterruption
            ? {
                aborted: true,
                replayInvalid: true,
                providerStarted: true,
                stopReason: primary === "returned-timeout" ? "timeout" : "aborted",
                ...(primary === "returned-timeout" ? { timeoutPhase: "provider" } : {}),
              }
            : {}),
        },
      };
      const providerFailure =
        primary === "provider"
          ? ({ reason: "auth", status: 401 } as const)
          : primary === "overload"
            ? ({ reason: "overloaded", status: 503 } as const)
            : primary === "http-507"
              ? ({ reason: "timeout", status: 507 } as const)
              : undefined;
      const primaryError = providerFailure
        ? primary === "http-507"
          ? Object.assign(new Error("provider request failed"), { status: 507 })
          : new FailoverError("provider failed", providerFailure)
        : primary === "abort"
          ? createAgentRunDirectAbortError()
          : primary === "timeout"
            ? await abortable(
                AbortSignal.abort(new DOMException("turn timed out", "TimeoutError")),
                Promise.resolve(),
              ).catch((error: unknown) => {
                if (!(error instanceof Error)) {
                  throw error;
                }
                return error;
              })
            : undefined;
      if (primaryError) {
        attachErrorDiagnostic(primaryError, "original provider diagnostic");
        Object.freeze(primaryError);
      }
      const remote = path.join(await realpath(root), "remote");
      await mkdir(remote);
      const bytes = Buffer.from("remote attachment");
      const saved = await saveMediaBuffer(bytes, "text/plain", "inbound", bytes.length, "note.txt");
      const inputTurn = {
        ...turn("run-remote-exec"),
        transcriptPrompt: "Canonical transcript request",
        media: [{ path: saved.path, contentType: "text/plain" }],
      };
      const originalPrompt = inputTurn.prompt;
      seedActivePlacement("remote-exec", remote);
      const order: string[] = [];
      const launchTurn = vi.fn();
      const quiesceWorkspace = vi.fn(async () => {
        order.push("quiesce");
        return {
          assertActive: vi.fn(async () => {}),
          resume: vi.fn(async () => {
            order.push("resume");
          }),
        };
      });
      const reconcileWorkspace = vi.fn(
        async (request: Parameters<WorkerTunnelHandle["reconcileWorkspace"]>[0]) => {
          if (request.source.kind !== "local") {
            throw new Error("expected a local workspace source");
          }
          order.push("reconcile");
          request.source.journal.commit(MANIFEST_REF);
          return {
            manifestRef: MANIFEST_REF,
            changed: false,
            verifyStable: vi.fn(async () => {}),
            verifyLocalStable: vi.fn(async () => {}),
          };
        },
      );
      const tunnel: WorkerTunnelHandle = {
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        measureLaunchTurn,
        launchTurn,
        runWorkspaceCommand: async (command) =>
          await runCommandWithTimeout([...command.argv], {
            cwd: remote,
            input: command.input,
            timeoutMs: 5_000,
            signal: command.signal,
          }),
        quiesceWorkspace,
        syncWorkspace: vi.fn(),
        reconcileWorkspace,
        stop: vi.fn(async () => {}),
      };
      const secret = ["synthetic", "cleanup", "credential"].join("-");
      const cleanupDetail = `native close failed: HTTP 401 request timed out Authorization: Bearer ${secret} ${"x".repeat(3000)}`;
      const cleanupError = new AggregateError([new Error(cleanupDetail)], "computer close failed");
      const closeComputer = vi.fn(async () => {
        expect(inputTurn.prompt).toBe(originalPrompt);
        expect(inputTurn.transcriptPrompt).toBe("Canonical transcript request");
        order.push("close");
        if (closeFails) {
          throw cleanupError;
        }
      });
      const computer: PreparedWorkerComputer = {
        descriptor: computerDescriptor(nodeDeviceId ?? "unused-ssh-node"),
        bind: () => {
          throw new Error("unexpected computer binding");
        },
        close: closeComputer,
      };
      const environments: WorkerTurnEnvironmentService = {
        ...unusedEnvironments(),
        get: vi.fn(() =>
          nodeDeviceId
            ? { ...attachedEnvironment(), providerId, nodeDeviceId, sshEndpoint: null }
            : attachedEnvironment(),
        ),
        startTunnel: vi.fn(async () => tunnel),
        prepareComputer: vi.fn(async () => (nodeDeviceId ? computer : undefined)),
      };
      const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
      const successorGate = vi.spyOn(provider, "assertCompactionSuccessorAllowed");
      let retainedNodeAuthority: (() => void) | undefined;
      const runLocal = vi.fn(() =>
        withWorkerCompactionAdoption("run-remote-exec", async (adopt) => {
          order.push("local");
          expect(inputTurn.prompt).toContain(`${originalPrompt}\n\nCurrent attachment originals`);
          expect(inputTurn.transcriptPrompt).toBe("Canonical transcript request");
          const placementBefore = placements.get(SESSION_ID);
          const entryBefore = loadSessionEntry(sessionTarget);
          expect(placementBefore?.turnClaim).toMatchObject({
            owner: "local",
            runId: "run-remote-exec",
          });
          await expect(adopt(SESSION_ID)).resolves.toBeUndefined();
          expect(successorGate).not.toHaveBeenCalled();
          await expect(adopt("session-remote-successor")).rejects.toThrow(
            /worker placement.*same session ID/u,
          );
          expect(placements.get(SESSION_ID)).toEqual(placementBefore);
          expect(loadSessionEntry(sessionTarget)).toEqual(entryBefore);
          expect(placements.get("session-remote-successor")).toBeUndefined();
          if (nodeDeviceId) {
            const assertCurrent = getPluginRuntimeGatewayRequestScope()?.assertNodeExecutionCurrent;
            expect(assertCurrent).toBeTypeOf("function");
            const request = {
              runId: "run-remote-exec",
              agentId: "main",
              nodeId: nodeDeviceId,
              workspace: {
                workspaceDir: remote,
                environmentId: ENVIRONMENT_ID,
                sessionId: SESSION_ID,
                sessionKey: SESSION_KEY,
                ownerEpoch: OWNER_EPOCH,
              },
            };
            retainedNodeAuthority = () => assertCurrent!(request);
            retainedNodeAuthority();
            for (const changed of [
              { ...request, runId: "other" },
              { ...request, nodeId: "other" },
              ...[
                { ownerEpoch: OWNER_EPOCH + 1 },
                { environmentId: "other" },
                { sessionId: "other" },
                { workspaceDir: "/other" },
              ].map((workspace) =>
                Object.assign({}, request, {
                  workspace: Object.assign({}, request.workspace, workspace),
                }),
              ),
            ]) {
              expect(() => assertCurrent!(changed)).toThrow("no longer current");
            }
            const original = environments.get(ENVIRONMENT_ID)!;
            if (original.state !== "attached") {
              throw new Error("expected an attached environment");
            }
            for (const changed of [
              { ...original, nodeDeviceId: "replacement" },
              { ...original, leaseId: "replacement" },
            ]) {
              vi.mocked(environments.get).mockReturnValueOnce(changed);
              await Promise.resolve();
              expect(retainedNodeAuthority).toThrow("no longer current");
            }
          }
          if (primaryError) {
            throw primaryError;
          }
          return localResult;
        }),
      );
      const resourceCleanup = pauseSkillCleanup
        ? { entered: createDeferred(), release: createDeferred() }
        : undefined;
      const skillCleanupError = new Error("synthetic security cleanup failure");
      const snapshot = { skills: [], resolvedSkills: [], prompt: "" };
      const transfer = resourceCleanup
        ? vi.spyOn(skillTransfer, "transferSkillResources").mockResolvedValue({
            source: snapshot,
            snapshot,
            mounts: [],
            assertCurrent: () => {},
            cleanup: async () => {
              resourceCleanup.entered.resolve();
              await resourceCleanup.release.promise;
              throw skillCleanupError;
            },
          })
        : undefined;
      const uninstall = installSessionPlacementAdmissionProvider(provider);
      const operation = provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "run-remote-exec",
        },
        inputTurn,
        runLocal,
      );
      try {
        if (resourceCleanup) {
          await resourceCleanup.entered.promise;
          expect(placements.get(SESSION_ID)?.turnClaim).not.toBeNull();
          expect(retainedNodeAuthority).toThrow("no longer current");
          expect(closeComputer).not.toHaveBeenCalled();
          resourceCleanup.release.resolve();
          await expect(operation).rejects.toBe(skillCleanupError);
        } else if (primaryError) {
          const failure = await operation.catch((error: unknown) => error);
          expect(failure).toBe(primaryError);
          const display = formatErrorMessageForDisplay(failure);
          expect(display).toContain("original provider diagnostic");
          if (closeFails) {
            expect.soft(display).toContain("computer close failed | native close failed");
          }
          expect(display).not.toContain(secret);
          if (providerFailure) {
            expect(primaryError).toMatchObject(
              primary === "http-507" ? { status: providerFailure.status } : providerFailure,
            );
            expect.soft(resolveModelFallbackError(failure)).toEqual({
              kind: closeFails ? "terminal" : "failover",
              error:
                closeFails || primary !== "http-507"
                  ? primaryError
                  : expect.objectContaining(providerFailure),
            });
          }
          const failures = [
            failure,
            ...(providerFailure && closeFails
              ? [
                  new Error("outer failure", { cause: failure }),
                  new AggregateError([failure], "outer aggregate"),
                ]
              : []),
          ];
          for (const error of failures) {
            const run = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(localResult);
            const fallback = runWithModelFallback({
              cfg: undefined,
              manifestPlugins: [],
              run,
              provider: "fixture-provider",
              model: "fixture-model",
              fallbacksOverride: ["fixture-next/fixture-model"],
            });
            if (providerFailure && !closeFails) {
              await expect(fallback).resolves.toMatchObject({
                outcome: "completed",
                result: localResult,
                attempts: [providerFailure],
              });
              expect(run).toHaveBeenCalledTimes(2);
            } else {
              await expect(fallback).rejects.toBe(error);
              expect(run).toHaveBeenCalledOnce();
            }
          }
        } else {
          const result = await operation;
          if (!closeFails) {
            expect(result).toBe(localResult);
          } else {
            const prefix = "Computer cleanup also failed: ";
            const diagnostic = result.payloads?.at(-1);
            expect(diagnostic).toMatchObject({
              isError: true,
              text: expect.stringContaining(`${prefix}computer close failed | native close failed`),
            });
            expect(diagnostic?.text?.length).toBeLessThanOrEqual(prefix.length + 1024);
            expect(result.meta.error).toMatchObject({
              kind: localResult.meta.error?.kind ?? "incomplete_turn",
              fallbackSafe: false,
            });
            expect(result.meta.error?.message).toContain(diagnostic?.text);
            if (localResult.meta.error) {
              expect(result.meta.error?.message).toContain(localResult.meta.error.message);
            }
            expect(result.meta).toEqual({
              ...localResult.meta,
              error: result.meta.error,
              replayInvalid: true,
            });
            expect(result.payloads?.slice(0, -1)).toEqual(localResult.payloads);
            expect(result.didSendViaMessagingTool).toBe(localResult.didSendViaMessagingTool);
            expect(result.messagingToolSentTexts).toEqual(localResult.messagingToolSentTexts);
            expect(JSON.stringify(result)).not.toContain(secret);
            const runCandidate = vi.fn(async () => result);
            const entry = await runEmbeddedAgentEntry({
              selection: {
                cfg: {},
                provider: "fixture-provider",
                model: "fixture-model",
                manifestPlugins: [],
                fallbacksOverride: ["fixture-next/fixture-model"],
              },
              identity: { runId: "settlement-entry", agentId: "main", sessionId: SESSION_ID },
              harness: {
                workspaceDir: root,
                sessionKey: SESSION_KEY,
                preparation: { kind: "direct" },
                resolveRuntimeOverride: () => "openclaw",
              },
              behavior: { kind: "command-rpc", hasCommittedSideEffect: () => false },
              sessionOverride: { kind: "preserve" },
              runCandidate,
            });
            expect(runCandidate).toHaveBeenCalledOnce();
            expect(entry.attempts).toEqual([]);
            expect(entry.terminal.outcome.status).toBe(
              primary === "returned-timeout" ? "timeout" : "error",
            );
            expect(entry.terminal.metadata.replayInvalid).toBe(true);
            if (returnedInterruption) {
              expect(entry.terminal.metadata.aborted).toBe(true);
              expect(entry.terminal.metadata.stopReason).toBe(localResult.meta.stopReason);
            }
          }
        }
      } finally {
        resourceCleanup?.release.resolve();
        await operation.catch(() => undefined);
        transfer?.mockRestore();
        uninstall();
        inputTurn.preparedRunAdmission.close();
      }
      expect(inputTurn.prompt).toBe(originalPrompt);
      expect(inputTurn.transcriptPrompt).toBe("Canonical transcript request");
      expect(closeComputer).toHaveBeenCalledTimes(nodeDeviceId ? 1 : 0);
      expect(order).toEqual([
        "local",
        ...(nodeDeviceId ? ["close"] : []),
        "quiesce",
        "reconcile",
        "resume",
      ]);
      expect(launchTurn).not.toHaveBeenCalled();
      expect(environments.acquireTurnCredential).not.toHaveBeenCalled();
      expect(placements.listPendingWorkspaceResults()).toEqual([]);
      const placement = placements.get(SESSION_ID);
      expect([placement?.state, placement?.turnClaim]).toEqual(["active", null]);
      if (retainedNodeAuthority) {
        expect(retainedNodeAuthority).toThrow("no longer current");
      }
    },
  );
});
