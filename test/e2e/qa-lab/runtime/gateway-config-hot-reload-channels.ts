import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createQaBusState,
  createQaChannelTransport,
  createQaGatewayChild,
  startQaBusServer,
  startQaMockOpenAiServer,
  type MockOpenAiRequestSnapshot,
} from "../../../../extensions/qa-lab/api.js";
import type { ChannelAccountSnapshot } from "../../../../src/channels/plugins/types.core.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import type { HeartbeatEventPayload } from "../../../../src/infra/heartbeat-events.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import {
  connectHotReloadClient,
  waitForHotReloadFact,
  type HotReloadConnection,
} from "./gateway-config-hot-reload-fixtures.js";
import { proveHotReloadIrcAccounts } from "./gateway-config-hot-reload-irc.js";
import { proveHotReloadChannelPolicy } from "./gateway-config-hot-reload-policy.js";

const CHANNEL = "qa-channel";
const MODELS = ["mock-openai/gpt-5.6-luna", "mock-openai/gpt-5.6-luna-alt"] as const;
type Evidence = { prefix: string; observation: string; bootId: string; pid: number };

export async function proveHotReloadChannels({
  repoRoot,
  outputDir,
  appendLog,
}: {
  repoRoot: string;
  outputDir: string;
  appendLog: (text: string) => void;
}) {
  const owner = createQaGatewayChild();
  const state = createQaBusState();
  const transport = createQaChannelTransport(state);
  const evidence: Evidence[] = [];
  const failures: Array<{ prefix: string; message: string }> = [];
  const observations: Array<Record<string, unknown>> = [];
  let connection: HotReloadConnection | undefined;
  let bus: Awaited<ReturnType<typeof startQaBusServer>> | undefined;
  let provider: Awaited<ReturnType<typeof startQaMockOpenAiServer>> | undefined;
  await runQaGatewayFixture(
    async () => {
      bus = await startQaBusServer({ state });
      provider = await startQaMockOpenAiServer({ modelRefs: MODELS });
      const mock = provider;
      const active = await owner.start({
        repoRoot,
        useRepoCli: true,
        command: {
          executablePath: process.execPath,
          argsPrefix: [path.join(repoRoot, "dist/index.js")],
          cwd: repoRoot,
          usePackagedPlugins: true,
        },
        providerMode: "mock-openai",
        forcedRuntime: "openclaw",
        providerBaseUrl: `${mock.baseUrl}/v1`,
        primaryModel: MODELS[0],
        alternateModel: MODELS[1],
        controlUiEnabled: false,
        transport,
        transportBaseUrl: bus.baseUrl,
        mutateConfig: (cfg) => ({
          ...cfg,
          gateway: { ...cfg.gateway, reload: { mode: "hybrid" } },
          session: { ...cfg.session, dmScope: "per-account-channel-peer" },
          agents: {
            ...cfg.agents,
            defaults: {
              ...cfg.agents?.defaults,
              heartbeat: {
                agentId: "qa",
                every: "24h",
                target: CHANNEL,
                to: "dm:hot-reload-heartbeat",
                accountId: "default",
                prompt: "Reply exactly `HEARTBEAT_OK`",
              },
            },
          },
          channels: {
            ...cfg.channels,
            [CHANNEL]: {
              ...cfg.channels?.[CHANNEL],
              accounts: { default: {}, parked: {} },
              defaultAccount: "default",
            },
          },
        }),
      });
      connection = await connectHotReloadClient(active);
      const primary = connection;
      const pid = active.pid;
      const bootId = primary.bootId;
      assert(pid && bootId);
      const rpc = async <T>(method: string, params: unknown = {}): Promise<T> => {
        const request = () => primary.client.request<T>(method, params, { timeoutMs: 40_000 });
        try {
          return await request();
        } catch (error) {
          const failure = error as { retryable?: boolean; retryAfterMs?: number; message?: string };
          if (
            !failure.retryable ||
            typeof failure.retryAfterMs !== "number" ||
            !failure.message?.startsWith(`rate limit exceeded for ${method}`)
          ) {
            throw error;
          }
          await delay(failure.retryAfterMs);
          return await request();
        }
      };
      const accounts = async () =>
        (
          await rpc<{ channelAccounts: Record<string, ChannelAccountSnapshot[]> }>(
            "channels.status",
            { probe: false },
          )
        ).channelAccounts[CHANNEL] ?? [];
      const ready = (accountId: string) =>
        waitForHotReloadFact(`${accountId} channel ready`, async () =>
          (await accounts()).find(
            (account) =>
              account.accountId === accountId &&
              account.running &&
              account.connected &&
              account.lifecycle === "ready" &&
              !account.restartPending,
          ),
        );
      await ready("default");
      await ready("parked");
      await rpc("channels.stop", { channel: CHANNEL, accountId: "parked" });
      const stopped = (await accounts()).find((account) => account.accountId === "parked");
      assert(stopped && stopped.running === false && stopped.lifecycle === "stopped");
      const parkedMessage = state.addInboundMessage({
        accountId: "parked",
        conversation: { kind: "direct", id: "hot-reload-parked" },
        senderId: "qa-operator",
        text: "Reply exactly `PARKED_ACCOUNT_RESUMED`",
      });
      const checkStopped = async () => {
        const account = (await accounts()).find((item) => item.accountId === "parked");
        assert(account && account.running === false && account.lifecycle === "stopped");
        assert.equal(account.lastStartAt, stopped.lastStartAt);
        assert(
          !state
            .getSnapshot()
            .messages.some(
              (message) => message.accountId === "parked" && message.direction === "outbound",
            ),
          "Automatic reload resumed a manually stopped account",
        );
        return account;
      };
      const patch = async (change: unknown, replacePaths?: string[], refreshChannel = true) => {
        const previous = await ready("default");
        const snapshot = await rpc<{ hash: string; config: OpenClawConfig }>("config.get");
        const result = await rpc<{
          sentinel: { payload: { stats: { requiresRestart: boolean } } };
        }>("config.patch", { baseHash: snapshot.hash, raw: JSON.stringify(change), replacePaths });
        assert.equal(result.sentinel.payload.stats.requiresRestart, false);
        if (refreshChannel) {
          await waitForHotReloadFact("channel snapshot replaced", async () => {
            const account = await ready("default");
            return (account.lastStartAt ?? 0) > (previous.lastStartAt ?? 0) ? account : undefined;
          });
        }
        await checkStopped();
      };
      const providerRequests = async () => {
        const response = await fetch(`${mock.baseUrl}/debug/requests`);
        assert(response.ok);
        return (await response.json()) as MockOpenAiRequestSnapshot[];
      };
      const record = async (prefix: string, observation: string) => {
        assert.equal((await rpc<{ pid: number }>("system.info")).pid, pid);
        assert.equal(primary.closes, 0);
        assert.equal(primary.hellos, 1);
        const fresh = await connectHotReloadClient(active);
        try {
          assert.equal(fresh.bootId, bootId);
        } finally {
          await fresh.client.stopAndWait();
        }
        observations.push({ prefix, stoppedAccount: await checkStopped() });
        evidence.push({ prefix, observation, bootId, pid });
        appendLog(`PASS channels ${prefix}: ${observation}; PID ${pid}, boot ${bootId}\n`);
      };
      const group = async (prefix: string, run: () => Promise<void>) => {
        try {
          await run();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push({ prefix, message });
          appendLog(`FAIL channels ${prefix}: ${message}\n`);
        }
      };

      await group("channels.modelByChannel", async () => {
        for (const [index, model] of [MODELS[0], MODELS[1], MODELS[0]].entries()) {
          await patch({ channels: { modelByChannel: { [CHANNEL]: { "*": model } } } });
          const marker = `CHANNEL_MODEL_${index}`;
          const requestCursor = (await providerRequests()).at(-1)?.cursor ?? 0;
          const inbound = await transport.sendInbound({
            conversation: { kind: "direct", id: "hot-reload-model" },
            senderId: "qa-operator",
            text: `Reply exactly \`${marker}\``,
          });
          const cursor = state.getSnapshot().cursor;
          const reply = await transport.waitForOutbound({
            conversation: inbound.conversation,
            textIncludes: marker,
            timeoutMs: 40_000,
          });
          assert.equal(reply.isError, undefined);
          await waitForHotReloadFact("channel turn acknowledged", () =>
            state.getAcknowledgedPollCursor("default") >= cursor ? true : undefined,
          );
          const requests = (await providerRequests()).filter(
            (request) => request.cursor > requestCursor && request.prompt.includes(marker),
          );
          assert(requests.length > 0, "The real channel turn never reached the provider");
          assert(requests.every((request) => request.model === model.split("/")[1]));
          observations.push({
            prefix: "channels.modelByChannel",
            model,
            reply,
            requests: requests.map(({ cursor: requestId, model: wireModel }) => ({
              requestId,
              wireModel,
            })),
          });
        }
        await record(
          "channels.modelByChannel",
          "The same QA conversation delivered three real replies through provider models A→B→A; the running account restarted and the manually stopped account stayed stopped",
        );
      });
      await group("channels.defaults", async () => {
        for (const [index, showOk] of [false, true, false].entries()) {
          await patch({
            channels: {
              defaults: { heartbeatVisibility: { showOk, showAlerts: false, useIndicator: true } },
            },
          });
          const before = await rpc<HeartbeatEventPayload | null>("last-heartbeat");
          const cursor = (await providerRequests()).at(-1)?.cursor ?? 0;
          const outboundBefore = state
            .getSnapshot()
            .messages.filter(
              (message) =>
                message.direction === "outbound" &&
                message.conversation.id === "hot-reload-heartbeat",
            ).length;
          await rpc("wake", {
            agentId: "qa",
            mode: "now",
            text: `Run the configured heartbeat check: CHANNEL_HEARTBEAT_${index}.`,
          });
          const event = await waitForHotReloadFact(
            "heartbeat completion",
            async () => {
              const current = await rpc<HeartbeatEventPayload | null>("last-heartbeat");
              return current && current.ts > (before?.ts ?? 0) ? current : undefined;
            },
            40_000,
          );
          // Reply normalization removes plain HEARTBEAT_OK before the heartbeat owner,
          // which receives an empty successful result and still applies showOk.
          assert.equal(event.status, "ok-empty", JSON.stringify(event));
          assert.equal(event.channel, CHANNEL);
          assert.equal(event.silent, !showOk);
          const requests = (await providerRequests()).filter((request) => request.cursor > cursor);
          assert(requests.length > 0, "Heartbeat completion must follow an actual model run");
          const delivered = state
            .getSnapshot()
            .messages.filter(
              (message) =>
                message.direction === "outbound" &&
                message.conversation.id === "hot-reload-heartbeat",
            );
          assert.equal(delivered.length - outboundBefore, showOk ? 1 : 0);
          if (showOk) {
            assert.equal(delivered.at(-1)?.text, "HEARTBEAT_OK");
          }
          observations.push({
            prefix: "channels.defaults",
            showOk,
            event,
            delivered: delivered.length,
          });
        }
        await record(
          "channels.defaults",
          "Real heartbeat model runs changed silent→delivered HEARTBEAT_OK→silent through the QA channel; the running account restarted and the manually stopped account stayed stopped",
        );
      });
      await proveHotReloadChannelPolicy({
        transport,
        state,
        providerRequests,
        rpc,
        patch: (change, replacePaths) => patch(change, replacePaths, false),
        patchChannels: patch,
        proveGroup: group,
        verifyContinuity: record,
      });
      if (failures.length === 0) {
        await rpc("channels.start", { channel: CHANNEL, accountId: "parked" });
        await ready("parked");
        const resumed = await waitForHotReloadFact(
          "explicitly resumed account delivered its queued turn",
          () =>
            state
              .getSnapshot()
              .messages.find(
                (message) =>
                  message.accountId === "parked" &&
                  message.direction === "outbound" &&
                  message.text.includes("PARKED_ACCOUNT_RESUMED"),
              ),
        );
        observations.push({ manuallyResumed: { inboundId: parkedMessage.id, reply: resumed } });
      }
      const irc = await proveHotReloadIrcAccounts({ repoRoot, outputDir, appendLog });
      evidence.push(...irc.evidence);
      failures.push(...irc.failures);
      observations.push(...irc.observations);
    },
    () => connection?.client.stopAndWait(),
    () => stopQaGatewayFixture(owner, { preserveToDir: path.join(outputDir, "channels-gateway") }),
    () => bus?.stop(),
    () => provider?.stop(),
    async () => {
      await fs.mkdir(outputDir, { recursive: true });
      await fs.writeFile(
        path.join(outputDir, "gateway-config-hot-reload-channels.json"),
        `${JSON.stringify({ evidence, failures, observations }, null, 2)}\n`,
      );
    },
  );
  return { evidence, failures };
}
