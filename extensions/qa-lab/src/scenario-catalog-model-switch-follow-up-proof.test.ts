import path from "node:path";
import { parseModelRef } from "openclaw/plugin-sdk/agent-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";
import { readRawQaSessionStore } from "./suite-runtime-agent-session.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const { cleanup, makeTempDir } = createTempDirHarness();
const sessionKey = "agent:qa:model-switch";
const sessionId = "model-switch-follow-up";

afterEach(cleanup);

type ProviderMode = "mock-openai" | "live-frontier";

async function runModelSwitchFollowUpScenario(params: {
  providerMode: ProviderMode;
  initialReply: string;
  followUpReply?: string;
  followUpDelivery?: "visible" | "deleted-only" | "deleted-preview-then-visible";
  alternateModel?: string;
  persistedFollowUpModel?: { provider: string; model: string };
}) {
  const tempRoot = await makeTempDir("qa-model-switch-follow-up-");
  const runtimeEnv = { ...process.env, OPENCLAW_STATE_DIR: path.join(tempRoot, "state") };
  const state = createQaBusState();
  const requests: Array<{ allInputText: string; body: { model: string }; model: string }> = [];
  const primaryModel = "openai/primary-model";
  const alternateModel = params.alternateModel ?? "openai/alternate-model";
  const normalizeModelRef = (raw: string) =>
    parseModelRef(raw, raw.slice(0, raw.indexOf("/")), {
      allowPluginNormalization: false,
      manifestPlugins: [
        {
          modelIdNormalization: {
            providers: { anthropic: { aliases: { opus: "claude-opus-5" } } },
          },
        },
      ],
    });
  const env = {
    providerMode: params.providerMode,
    primaryModel,
    alternateModel,
    gateway: { tempRoot },
    ...(params.providerMode === "mock-openai" ? { mock: { baseUrl: "http://mock.invalid" } } : {}),
  };

  const result = await runLoadedScenarioFlow("model-switch-follow-up", {
    state,
    api: {
      env,
      splitModelRef: (ref: string) => {
        const slash = ref.indexOf("/");
        return slash > 0 ? { provider: ref.slice(0, slash), model: ref.slice(slash + 1) } : null;
      },
      normalizeModelRef,
      normalizeLowercaseStringOrEmpty: (value: unknown) =>
        typeof value === "string" ? value.trim().toLowerCase() : "",
      readRawQaSessionStore,
      resolveQaLiveTurnTimeoutMs: (_env: unknown, timeoutMs: number) => timeoutMs,
      fetchJson: async (rawUrl: string) => {
        const url = new URL(rawUrl);
        if (url.pathname === "/debug/last-request") {
          return requests.at(-1);
        }
        if (url.pathname === "/debug/request-cursor") {
          return { cursor: requests.length };
        }
        if (url.pathname === "/debug/requests") {
          return requests.slice(Number(url.searchParams.get("after") ?? "0"));
        }
        throw new Error(`unexpected mock provider endpoint: ${url.pathname}`);
      },
      runAgentPrompt: async (
        _env: unknown,
        prompt: { message: string; model?: string; provider?: string },
      ) => {
        state.addInboundMessage({
          accountId: "qa-channel",
          conversation: { id: "qa-operator", kind: "direct" },
          senderId: "qa-operator",
          text: prompt.message,
        });
        const requestedModel = prompt.model ?? "primary-model";
        const resolvedModel = normalizeModelRef(`${prompt.provider ?? "openai"}/${requestedModel}`);
        const model = resolvedModel?.model ?? requestedModel;
        requests.push({ allInputText: prompt.message, body: { model }, model });

        const isFollowUp = requests.length > 1;
        const actualModel =
          isFollowUp && params.persistedFollowUpModel
            ? params.persistedFollowUpModel
            : { provider: resolvedModel?.provider ?? prompt.provider ?? "openai", model };
        await upsertSessionEntry({
          agentId: "qa",
          env: runtimeEnv,
          sessionKey,
          entry: {
            sessionId,
            updatedAt: Date.now(),
            modelProvider: actualModel.provider,
            model: actualModel.model,
          },
        });

        const reply = isFollowUp ? params.followUpReply : params.initialReply;
        if (reply !== undefined) {
          const outbound = state.addOutboundMessage({
            accountId: "qa-channel",
            to: "dm:qa-operator",
            text: reply,
          });
          if (isFollowUp && params.followUpDelivery !== undefined) {
            if (params.followUpDelivery !== "visible") {
              state.deleteMessage({ accountId: "qa-channel", messageId: outbound.id });
            }
            if (params.followUpDelivery === "deleted-preview-then-visible") {
              state.addOutboundMessage({
                accountId: "qa-channel",
                to: "dm:qa-operator",
                text: reply,
              });
            }
          }
        }
      },
    },
  });

  return { env, requests, result, state };
}

describe("model-switch follow-up scenario outbound evidence", () => {
  it.each([
    ["mock-openai", "The requested handoff comes next."],
    ["mock-openai", "The requested model switch comes next."],
    ["live-frontier", "The requested handoff comes next."],
    ["live-frontier", "The requested model switch comes next."],
  ] as const)(
    "rejects a stale first-turn handoff signal when %s produces no follow-up reply",
    async (providerMode, initialReply) => {
      await expect(runModelSwitchFollowUpScenario({ providerMode, initialReply })).rejects.toThrow(
        "test condition was not met",
      );
    },
  );

  it.each(["mock-openai", "live-frontier"] as const)(
    "accepts a fresh alternate-model reply after mixed first-turn traffic (%s)",
    async (providerMode) => {
      const followUpReply = "The alternate-model handoff completed successfully.";
      const { requests, result, state } = await runModelSwitchFollowUpScenario({
        providerMode,
        initialReply: "The requested handoff comes next.",
        followUpReply,
      });

      expect(result.status).toBe("pass");
      expect(result.steps[1]?.details).toBe(followUpReply);
      expect(requests.map((request) => request.model)).toEqual([
        "primary-model",
        "alternate-model",
      ]);
      expect(state.getSnapshot().messages.map((message) => message.direction)).toEqual([
        "inbound",
        "outbound",
        "inbound",
        "outbound",
      ]);
    },
  );

  it.each([
    ["mock-openai", "anthropic/opus", "anthropic"],
    ["live-frontier", "anthropic/opus", "anthropic"],
    ["mock-openai", "Anthropic/opus", "ANTHROPIC"],
    ["live-frontier", "Anthropic/opus", "ANTHROPIC"],
  ] as const)(
    "accepts the canonical persisted model for %s alias %s with provider %s",
    async (providerMode, alternateModel, persistedProvider) => {
      const { env, requests, result } = await runModelSwitchFollowUpScenario({
        providerMode,
        alternateModel,
        initialReply: "The requested handoff comes next.",
        followUpReply: "The alternate-model handoff completed successfully.",
        persistedFollowUpModel: { provider: persistedProvider, model: "claude-opus-5" },
      });

      expect(result.status).toBe("pass");
      expect(requests.at(-1)?.model).toBe("claude-opus-5");
      expect(await readRawQaSessionStore(env)).toMatchObject({
        [sessionKey]: { modelProvider: persistedProvider, model: "claude-opus-5" },
      });
    },
  );

  it.each([
    ["mock-openai", "openai", "primary-model"],
    ["mock-openai", "anthropic", "alternate-model"],
    ["live-frontier", "openai", "primary-model"],
    ["live-frontier", "anthropic", "alternate-model"],
  ] as const)(
    "rejects a fresh handoff when the persisted %s run used %s/%s",
    async (providerMode, provider, model) => {
      await expect(
        runModelSwitchFollowUpScenario({
          providerMode,
          initialReply: "The requested handoff comes next.",
          followUpReply: "The alternate-model handoff completed successfully.",
          persistedFollowUpModel: { provider, model },
        }),
      ).rejects.toThrow(/alternate.*model|persisted.*model|model.*switch/i);
    },
  );

  it.each(["mock-openai", "live-frontier"] as const)(
    "rejects a deleted fresh handoff when no visible final reply remains (%s)",
    async (providerMode) => {
      await expect(
        runModelSwitchFollowUpScenario({
          providerMode,
          initialReply: "The requested handoff comes next.",
          followUpReply: "The alternate-model handoff completed successfully.",
          followUpDelivery: "deleted-only",
        }),
      ).rejects.toThrow("test condition was not met");
    },
  );

  it.each(["mock-openai", "live-frontier"] as const)(
    "accepts a visible final handoff after its streaming preview was deleted (%s)",
    async (providerMode) => {
      const { env, result, state } = await runModelSwitchFollowUpScenario({
        providerMode,
        initialReply: "The requested handoff comes next.",
        followUpReply: "The alternate-model handoff completed successfully.",
        followUpDelivery: "deleted-preview-then-visible",
      });

      expect(result.status).toBe("pass");
      expect(await readRawQaSessionStore(env)).toMatchObject({
        [sessionKey]: { modelProvider: "openai", model: "alternate-model" },
      });
      expect(
        state
          .getSnapshot()
          .messages.filter((message) => message.direction === "outbound")
          .map((message) => message.deleted === true),
      ).toEqual([false, true, false]);
    },
  );
});
