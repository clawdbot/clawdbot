import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeQaHttpServer,
  dispatchQaHttpRequest,
  readQaJsonBody,
  startQaBusServer,
} from "./bus-server.js";
import { createQaBusState } from "./bus-state.js";
import type { QaGatewayChildParams } from "./gateway-child-setup.js";
import { createQaGatewayChild } from "./gateway-child.js";
import { isQaPosixProcessGroupAlive, signalQaPosixProcessGroup } from "./posix-process-group.js";
import {
  QA_KILL_RESTART_RECOVERED_MARKER,
  QA_SUBAGENT_SELF_YIELD_MARKER,
} from "./providers/mock-openai/mock-openai-contracts.js";
import { startQaMockOpenAiServer } from "./providers/mock-openai/server.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";
import { waitForQaTransportCondition } from "./qa-transport.js";
import {
  readRawQaSessionStore,
  readSessionTranscriptSummary,
} from "./suite-runtime-agent-session.js";

const PLUGIN_ID = "qa-self-yield-followup-subagent";
const TRIGGER = "qa self yield follow-up";
const REQUESTER_CONVERSATION = { id: "requester-user", kind: "direct" as const };
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const PLUGIN_DIR = path.join(
  REPO_ROOT,
  "extensions/qa-lab/test-fixtures/self-yield-followup-subagent-plugin",
);
const VERDICT_PATH = path.join(
  REPO_ROOT,
  ".artifacts/qa-e2e/handoff-adoption/channel-handoff-verdict.json",
);

type RestartObservation = {
  task?: {
    id: string;
    runId: string;
    flowId: string;
    sessionKey: string;
    childSessionKey: string;
    ownerKey: string;
    status: string;
    endedAt?: number;
    error?: string;
    cleanupAfter?: number;
  };
  flow?: { id: string; ownerKey: string; status: string; endedAt?: number };
};

function readRestartBacking(databasePath: string, taskId: string, childSessionKey: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const task = database
      .prepare("SELECT detail_json FROM task_runs WHERE task_id = ?")
      .get(taskId);
    const row = database
      .prepare(
        "SELECT payload_json FROM subagent_runs WHERE child_session_key = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(childSessionKey);
    expect(task).toBeDefined();
    expect(row).toBeDefined();
    return {
      detail: JSON.parse(String(task?.detail_json)) as { runtime: string; generation: number },
      run: JSON.parse(String(row?.payload_json)) as {
        runId: string;
        taskRunId: string;
        childSessionKey: string;
        requesterSessionKey: string;
        requesterOrigin: unknown;
        generation: number;
        execution: { status: string; lifecycleGeneration: string; endedAt?: number };
      },
    };
  } finally {
    database.close();
  }
}

function withFixturePlugin(config: OpenClawConfig): OpenClawConfig {
  return {
    ...config,
    plugins: {
      ...config.plugins,
      enabled: true,
      allow: [...new Set([...(config.plugins?.allow ?? []), PLUGIN_ID])],
      load: {
        ...config.plugins?.load,
        paths: [...new Set([...(config.plugins?.load?.paths ?? []), PLUGIN_DIR])],
      },
      entries: {
        ...config.plugins?.entries,
        [PLUGIN_ID]: { enabled: true },
      },
    },
  };
}

describe("plugin subagent sessions_yield follow-up", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup();
    }
  });

  async function startFixtureGateway(
    options: Pick<QaGatewayChildParams, "forcedRuntime" | "mutateConfig" | "useRepoCli"> = {},
    interceptProvider?: (baseUrl: string) => Promise<string>,
  ) {
    const state = createQaBusState();
    const transport = createQaChannelTransport(state);
    const bus = await startQaBusServer({ state });
    cleanups.push(() => bus.stop());
    const mock = await startQaMockOpenAiServer();
    cleanups.push(() => mock.stop());
    const owner = createQaGatewayChild();
    cleanups.push(async () => {
      expect((await owner.stop()).errors).toEqual([]);
    });
    const providerBaseUrl = interceptProvider
      ? await interceptProvider(mock.baseUrl)
      : mock.baseUrl;
    const gateway = await owner.start({
      repoRoot: REPO_ROOT,
      useRepoCli: true,
      providerBaseUrl: `${providerBaseUrl}/v1`,
      providerMode: "mock-openai",
      transport,
      transportBaseUrl: bus.baseUrl,
      controlUiEnabled: false,
      mutateConfig: withFixturePlugin,
      ...options,
    });
    return { state, transport, mock, gateway };
  }

  it.skipIf(process.platform === "win32")(
    "rearms a failed task projection during automatic process-restart recovery",
    async () => {
      let recoveryRequests = 0;
      let releaseRecovery: (() => void) | undefined;
      const recoveryGate = new Promise<void>((resolve) => {
        releaseRecovery = resolve;
      });
      const { state, transport, gateway } = await startFixtureGateway(
        {
          forcedRuntime: "openclaw",
          useRepoCli: false,
          mutateConfig: (config) => ({
            ...withFixturePlugin(config),
            tools: {
              ...config.tools,
              alsoAllow: [
                ...(config.tools?.alsoAllow ?? []),
                "qa_restart_wait",
                "qa_restart_unsafe_probe",
              ],
              codeMode: { enabled: true, timeoutMs: 10_000 },
            },
          }),
        },
        async (baseUrl) => {
          const proxy = createServer((request, response) => {
            dispatchQaHttpRequest(response, async () => {
              const body = await readQaJsonBody(request);
              const payload = JSON.stringify(body);
              if (
                payload.includes("KILL-RESTART-PROMPT") &&
                payload.includes("previous turn was interrupted by a gateway restart")
              ) {
                recoveryRequests += 1;
                await recoveryGate;
              }
              const upstream = await fetch(`${baseUrl}${request.url}`, {
                method: request.method,
                headers: { "Content-Type": "application/json" },
                body: payload,
              });
              response.writeHead(upstream.status, {
                "Content-Type": upstream.headers.get("content-type") ?? "application/json",
              });
              response.end(await upstream.text());
            });
          });
          await once(proxy.listen(0, "127.0.0.1"), "listening");
          cleanups.push(async () => {
            releaseRecovery?.();
            await closeQaHttpServer(proxy);
          });
          const address = proxy.address();
          if (!address || typeof address === "string") {
            throw new Error("QA provider gate did not bind");
          }
          return `http://127.0.0.1:${address.port}`;
        },
      );
      const sessionKey = buildAgentSessionKey({
        agentId: "qa",
        channel: "qa-channel",
        accountId: transport.accountId,
        peer: { kind: "direct", id: `dm:${REQUESTER_CONVERSATION.id}` },
        dmScope: gateway.cfg.session?.dmScope,
        identityLinks: gateway.cfg.session?.identityLinks,
      });
      const databasePath = path.join(gateway.tempRoot, "state", "state", "openclaw.sqlite");
      const observe = async (): Promise<RestartObservation> => {
        const response = await fetch(
          `${gateway.baseUrl}/qa/self-yield/restart?sessionKey=${encodeURIComponent(sessionKey)}`,
          { headers: { Authorization: `Bearer ${gateway.token}` } },
        );
        expect(response.status).toBe(200);
        return (await response.json()) as RestartObservation;
      };
      const outbound = () =>
        state.getSnapshot().messages.filter((message) => message.direction === "outbound");
      try {
        await transport.waitReady({ gateway });
        await transport.sendInbound({
          accountId: transport.accountId,
          conversation: REQUESTER_CONVERSATION,
          senderId: REQUESTER_CONVERSATION.id,
          text: "Reply with only this exact marker: QA-RESTART-REQUESTER-READY",
        });
        await transport.waitForOutbound({
          conversation: REQUESTER_CONVERSATION,
          textIncludes: "QA-RESTART-REQUESTER-READY",
          timeoutMs: 90_000,
        });
        const requester = (await readRawQaSessionStore({ gateway }))[sessionKey];
        expect(requester?.sessionId).toBeTruthy();
        await transport.sendInbound({
          accountId: transport.accountId,
          conversation: REQUESTER_CONVERSATION,
          senderId: REQUESTER_CONVERSATION.id,
          text: "qa interrupted task restart",
        });
        await transport.waitForOutbound({
          conversation: REQUESTER_CONVERSATION,
          textIncludes: "QA-RESTART-TASK-SPAWNED",
          timeoutMs: 90_000,
        });
        const original = await transport.waitForCondition(
          async () => {
            const observation = await observe();
            if (!observation.task || !observation.flow) {
              return undefined;
            }
            const transcript = await readSessionTranscriptSummary(
              { gateway },
              observation.task.childSessionKey,
              { allowEmpty: true },
            );
            return (transcript.assistantToolCallCounts.wait ?? 0) >
              (transcript.completedToolCallCounts.wait ?? 0)
              ? { task: observation.task, flow: observation.flow, transcript }
              : undefined;
          },
          90_000,
          25,
        );
        expect(original.task).toMatchObject({ sessionKey, status: "running" });
        expect(original.flow.status).toBe("running");
        const child = (await readRawQaSessionStore({ gateway }))[original.task.childSessionKey];
        expect(child?.sessionId).toBeTruthy();
        const before = readRestartBacking(
          databasePath,
          original.task.id,
          original.task.childSessionKey,
        );
        expect(before.run.execution.status).toBe("running");
        const restartDeliveryStart = outbound().length;
        const pid = gateway.pid;
        expect(pid).not.toBeNull();
        signalQaPosixProcessGroup(pid!, "SIGKILL");
        await waitForQaTransportCondition(
          () => (!isQaPosixProcessGroupAlive(pid!) ? true : undefined),
          30_000,
          25,
        );
        await gateway.restartAfterStateMutation(async () => {
          const sessions = await readRawQaSessionStore({ gateway });
          expect(sessions[original.task.childSessionKey]).toMatchObject({
            sessionId: child!.sessionId,
            status: "running",
          });
          const database = new DatabaseSync(databasePath);
          try {
            const subagents = database.prepare("SELECT * FROM subagent_runs").all();
            const endedAt = Date.now();
            // Inject only the observed terminal projection while the Gateway is stopped.
            // The real orphaned session/run remains untouched for startup recovery to own.
            database.exec("BEGIN IMMEDIATE");
            try {
              expect(
                database
                  .prepare(
                    "UPDATE task_runs SET status = 'failed', ended_at = ?, last_event_at = ?, error = ?, cleanup_after = ? WHERE task_id = ? AND run_id = ? AND status = 'running'",
                  )
                  .run(
                    endedAt,
                    endedAt,
                    "subagent run lost active execution context",
                    endedAt + 604_800_000,
                    original.task.id,
                    original.task.runId,
                  ).changes,
              ).toBe(1);
              expect(
                database
                  .prepare(
                    "UPDATE flow_runs SET status = 'failed', ended_at = ?, updated_at = ?, revision = revision + 1 WHERE flow_id = ? AND sync_mode = 'task_mirrored' AND status = 'running'",
                  )
                  .run(endedAt, endedAt, original.flow.id).changes,
              ).toBe(1);
              database.exec("COMMIT");
            } catch (error) {
              database.exec("ROLLBACK");
              throw error;
            }
            expect(database.prepare("SELECT * FROM subagent_runs").all()).toEqual(subagents);
          } finally {
            database.close();
          }
          expect(await readRawQaSessionStore({ gateway })).toEqual(sessions);
        });
        expect(gateway.pid).not.toBe(pid);
        await transport.waitReady({ gateway });
        const recovered = await transport.waitForCondition(
          async () => {
            const observation = await observe();
            if (recoveryRequests === 0) {
              return undefined;
            }
            const backing = readRestartBacking(
              databasePath,
              original.task.id,
              original.task.childSessionKey,
            );
            return backing.run.generation > before.run.generation
              ? { observation, backing }
              : undefined;
          },
          120_000,
          25,
        );
        expect(recoveryRequests).toBe(1);
        expect(recovered.backing.run).toMatchObject({
          taskRunId: original.task.runId,
          childSessionKey: original.task.childSessionKey,
          requesterSessionKey: sessionKey,
          requesterOrigin: before.run.requesterOrigin,
          execution: { status: "running" },
        });
        expect(recovered.backing.run.runId).toMatch(/^subagent-recovery:/);
        expect(recovered.backing.run.runId).not.toBe(before.run.runId);
        expect(recovered.backing.run.execution.endedAt).toBeUndefined();
        expect(recovered.backing.run.execution.lifecycleGeneration).toBeTruthy();
        expect(recovered.backing.run.execution.lifecycleGeneration).not.toBe(
          before.run.execution.lifecycleGeneration,
        );
        expect(recovered.backing.detail).toMatchObject({
          runtime: "subagent",
          generation: recovered.backing.run.generation,
        });
        expect(recovered.observation.task).toMatchObject({
          id: original.task.id,
          runId: original.task.runId,
          flowId: original.flow.id,
          sessionKey,
          childSessionKey: original.task.childSessionKey,
          ownerKey: original.task.ownerKey,
          status: "running",
        });
        expect(recovered.observation.task?.endedAt).toBeUndefined();
        expect(recovered.observation.task?.error).toBeUndefined();
        expect(recovered.observation.task?.cleanupAfter).toBeUndefined();
        expect(recovered.observation.flow).toMatchObject({
          id: original.flow.id,
          ownerKey: original.flow.ownerKey,
          status: "running",
        });
        expect(recovered.observation.flow?.endedAt).toBeUndefined();
        const resumedSessions = await readRawQaSessionStore({ gateway });
        expect(resumedSessions[sessionKey]?.sessionId).toBe(requester!.sessionId);
        expect(resumedSessions[original.task.childSessionKey]?.sessionId).toBe(child!.sessionId);
        const resumedNotice = await transport.waitForOutbound({
          conversation: REQUESTER_CONVERSATION,
          sinceIndex: restartDeliveryStart,
          textIncludes: "Resumed your interrupted task after the Gateway restart.",
          timeoutMs: 90_000,
        });
        expect(resumedNotice.accountId).toBe(transport.accountId);
        expect(
          outbound()
            .slice(restartDeliveryStart)
            .filter((message) => message.text.includes("Resumed your interrupted task")),
        ).toHaveLength(1);
        const deliveryStart = outbound().length;
        expect(
          outbound().some((message) => message.text.includes(QA_KILL_RESTART_RECOVERED_MARKER)),
        ).toBe(false);
        releaseRecovery?.();
        const completion = await transport.waitForOutbound({
          conversation: REQUESTER_CONVERSATION,
          sinceIndex: deliveryStart,
          textIncludes: QA_KILL_RESTART_RECOVERED_MARKER,
          timeoutMs: 90_000,
        });
        expect(completion.accountId).toBe(transport.accountId);
        await transport.waitForCondition(
          async () => {
            const observation = await observe();
            return observation.task?.status === "succeeded" &&
              observation.flow?.status === "succeeded"
              ? observation
              : undefined;
          },
          90_000,
          25,
        );
        expect(outbound().slice(deliveryStart)).toHaveLength(1);
        const completedPid = gateway.pid;
        await gateway.restartAfterStateMutation(async () => {});
        expect(gateway.pid).not.toBe(completedPid);
        await transport.waitReady({ gateway });
        // Observe a complete 60-second registry sweep after the second restart,
        // rather than checking only the interval before deferred work runs.
        await transport.waitForNoOutbound({ sinceIndex: deliveryStart + 1, quietMs: 65_000 });
        const restored = await observe();
        expect(restored.task).toMatchObject({
          id: original.task.id,
          runId: original.task.runId,
          status: "succeeded",
        });
        expect(restored.flow).toMatchObject({ id: original.flow.id, status: "succeeded" });
        expect(recoveryRequests).toBe(1);
        const finalSessions = await readRawQaSessionStore({ gateway });
        expect(finalSessions[sessionKey]?.sessionId).toBe(requester!.sessionId);
        expect(finalSessions[original.task.childSessionKey]?.sessionId).toBe(child!.sessionId);
        expect(
          readRestartBacking(databasePath, original.task.id, original.task.childSessionKey).run
            .runId,
        ).toBe(recovered.backing.run.runId);
        expect(outbound().slice(deliveryStart)).toHaveLength(1);
        const finalTranscript = await readSessionTranscriptSummary(
          { gateway },
          original.task.childSessionKey,
        );
        expect(finalTranscript.assistantToolCallCounts).toEqual(
          original.transcript.assistantToolCallCounts,
        );
        await mkdir(path.dirname(VERDICT_PATH), { recursive: true });
        await writeFile(
          path.join(path.dirname(VERDICT_PATH), "restart-recovery-verdict.json"),
          `${JSON.stringify(
            {
              scenario: "canonical-task-restart-recovery",
              status: "pass",
              gateway: "ephemeral",
              channel: "qa-channel",
              provider: "mock-openai",
              faultInjection: "terminal task/flow projection while Gateway stopped",
              originalGeneration: before.run.generation,
              recoveredGeneration: recovered.backing.run.generation,
              originalTaskId: original.task.id,
              restoredTaskId: restored.task?.id,
              restoredStatus: restored.task?.status,
              logicalRunId: original.task.runId,
              flowId: original.flow.id,
              requesterSessionKey: sessionKey,
              requesterSessionId: requester!.sessionId,
              childSessionKey: original.task.childSessionKey,
              childSessionId: child!.sessionId,
              predecessorRunId: before.run.runId,
              successorRunId: recovered.backing.run.runId,
              recoveryRequests,
              toolCallsBeforeRestart: original.transcript.assistantToolCallCounts,
              toolCallsAfterRestart: finalTranscript.assistantToolCallCounts,
              operatorPromptRequired: false,
              resumptionConfirmations: outbound()
                .slice(restartDeliveryStart)
                .filter((message) => message.text.includes("Resumed your interrupted task")).length,
              completionReplies: outbound().slice(deliveryStart).length,
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\nbus=${JSON.stringify(state.getSnapshot())}\ngateway=${gateway.logs()}`,
          { cause: error },
        );
      }
    },
    600_000,
  );

  it("announces to the original requester only after the follow-up run ends", async () => {
    const { state, transport, mock, gateway } = await startFixtureGateway();
    await transport.waitReady({ gateway });

    const outboundStartIndex = state
      .getSnapshot()
      .messages.filter((message) => message.direction === "outbound").length;
    await transport.sendInbound({
      accountId: "default",
      conversation: REQUESTER_CONVERSATION,
      senderId: REQUESTER_CONVERSATION.id,
      text: TRIGGER,
    });

    const failureContext = (error: unknown) =>
      new Error(
        [
          error instanceof Error ? error.message : String(error),
          `bus=${JSON.stringify(state.getSnapshot())}`,
          `gateway=${gateway.logs()}`,
        ].join("\n"),
        { cause: error },
      );
    let distinctFollowupRun: boolean;

    try {
      const followUpResponse = await fetch(`${gateway.baseUrl}/qa/self-yield/follow-up`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${gateway.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(followUpResponse.status).toBe(202);
      const followUp = (await followUpResponse.json()) as {
        kickoffRunId?: string;
        runId: string;
      };
      expect(followUp.runId).toBeTruthy();
      const releaseResponse = await fetch(`${gateway.baseUrl}/qa/self-yield/release`, {
        method: "POST",
        headers: { Authorization: `Bearer ${gateway.token}` },
      });
      expect(releaseResponse.status).toBe(200);
      const release = (await releaseResponse.json()) as {
        finalReply?: string;
        kickoffRunId?: string;
        runId?: string;
        status?: string;
      };
      expect(release).toMatchObject({
        finalReply: QA_SUBAGENT_SELF_YIELD_MARKER,
        status: "ok",
      });
      expect(release.kickoffRunId).toBeTruthy();
      expect(release.runId).toBe(followUp.runId);
      expect(release.runId).not.toBe(release.kickoffRunId);
      distinctFollowupRun = release.runId !== release.kickoffRunId;

      const completion = await transport.waitForOutbound({
        conversation: REQUESTER_CONVERSATION,
        sinceIndex: outboundStartIndex,
        textIncludes: QA_SUBAGENT_SELF_YIELD_MARKER,
        timeoutMs: 90_000,
      });
      expect(completion.accountId).toBe("default");
    } catch (error) {
      throw failureContext(error);
    }

    const outbound = state
      .getSnapshot()
      .messages.filter((message) => message.direction === "outbound");
    // Exactly one announce for the whole continued run: the paused kickoff must
    // not announce separately, and the follow-up must not announce twice.
    expect(
      outbound.filter((message) => message.text.includes(QA_SUBAGENT_SELF_YIELD_MARKER)),
    ).toHaveLength(1);
    const visibleRepliesBeforeQuiet = outbound.filter((message) =>
      message.text.includes(QA_SUBAGENT_SELF_YIELD_MARKER),
    ).length;
    await transport.waitForNoOutbound({
      sinceIndex: outbound.length,
      quietMs: 1_000,
    });
    const visibleRepliesAfterQuiet = state
      .getSnapshot()
      .messages.filter(
        (message) =>
          message.direction === "outbound" && message.text.includes(QA_SUBAGENT_SELF_YIELD_MARKER),
      ).length;
    await gateway.restartAfterStateMutation(async () => {});
    await transport.waitReady({ gateway });
    await transport.waitForNoOutbound({
      sinceIndex: outbound.length,
      quietMs: 1_000,
    });
    const visibleRepliesAfterRestart = state
      .getSnapshot()
      .messages.filter(
        (message) =>
          message.direction === "outbound" && message.text.includes(QA_SUBAGENT_SELF_YIELD_MARKER),
      ).length;
    const requests = (await fetch(`${mock.baseUrl}/debug/requests`).then((response) =>
      response.json(),
    )) as Array<{ plannedToolName?: string; prompt?: string }>;
    const handoffRequests = requests.filter(
      (request) =>
        request.prompt?.includes("Subagent self yield qa worker") ||
        request.prompt?.includes("Subagent self yield qa remote job finished"),
    );
    expect(requests).toHaveLength(2);
    const verdict = {
      schemaVersion: 1,
      scenario: "channel-handoff-adoption",
      status: "pass",
      channel: "qa-channel",
      provider: "mock-openai",
      gateway: "ephemeral",
      facts: {
        sessionsYieldCalls: requests.filter(
          (request) => request.plannedToolName === "sessions_yield",
        ).length,
        childModelRequests: handoffRequests.length,
        visibleReplies: outbound.filter((message) =>
          message.text.includes(QA_SUBAGENT_SELF_YIELD_MARKER),
        ).length,
        duplicateRepliesAfterQuietWindow: visibleRepliesAfterQuiet - visibleRepliesBeforeQuiet,
        duplicateRepliesAfterGatewayRestart: visibleRepliesAfterRestart - visibleRepliesAfterQuiet,
        distinctFollowupRun,
      },
    };
    expect(verdict.facts).toEqual({
      sessionsYieldCalls: 1,
      childModelRequests: 2,
      visibleReplies: 1,
      duplicateRepliesAfterQuietWindow: 0,
      duplicateRepliesAfterGatewayRestart: 0,
      distinctFollowupRun: true,
    });
    await mkdir(path.dirname(VERDICT_PATH), { recursive: true });
    await writeFile(VERDICT_PATH, `${JSON.stringify(verdict, null, 2)}\n`, "utf8");
  }, 180_000);
});
