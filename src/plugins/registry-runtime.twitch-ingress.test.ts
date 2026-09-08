import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  configureChannelAdmissionEvidenceCollection,
  consumeChannelAdmissionEvidence,
  readChannelContextAdmissionEvidence,
} from "../channels/message-access/admission-evidence.js";
import { importBundledChannelContractSourceArtifact } from "../channels/plugins/contracts/test-helpers/runtime-artifacts.js";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runChannelInboundEvent } from "../plugin-sdk/channel-inbound.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createRuntimeEnv } from "../test-utils/plugin-runtime-env.js";
import { markPluginRegistryActive, markPluginRegistryRetired } from "./registry-lifecycle.js";
import { createPluginRegistry } from "./registry.js";
import { createPluginRuntime } from "./runtime/index.js";
import type { PluginRuntime } from "./runtime/types.js";
import { createPluginRecord } from "./status.test-helpers.js";

const transport = await vi.hoisted(async () => {
  const { createDeferred } = await import("../../test/helpers/promise.js");
  type NativeMessage = {
    id: string;
    userInfo: {
      userName: string;
      displayName: string;
      userId?: string;
      isMod: boolean;
      isBroadcaster: boolean;
      isVip: boolean;
      isSubscriber: boolean;
    };
  };
  class ChatClient {
    static ready: ((client: ChatClient) => void) | undefined;
    auth = new Set<() => void>();
    messages = new Set<
      (channel: string, user: string, text: string, message: NativeMessage) => void
    >();
    sent = createDeferred();
    say = vi.fn(async (_channel: string, _text: string) => this.sent.resolve());
    quit = vi.fn();
    onAuthenticationSuccess(handler: () => void) {
      this.auth.add(handler);
      return { unbind: () => this.auth.delete(handler) };
    }
    onAuthenticationFailure() {
      return { unbind() {} };
    }
    onDisconnect() {
      return { unbind() {} };
    }
    onMessage(
      handler: (channel: string, user: string, text: string, message: NativeMessage) => void,
    ) {
      this.messages.add(handler);
      ChatClient.ready?.(this);
      return { unbind: () => this.messages.delete(handler) };
    }
    connect() {
      for (const handler of this.auth) {
        handler();
      }
    }
    receive(message: NativeMessage, text = "@testbot hello") {
      // Native socket events arrive after connection-setup microtasks finish.
      setImmediate(() => {
        for (const handler of this.messages) {
          handler("#testchannel", "viewer", text, message);
        }
      });
    }
  }
  return { ChatClient, createDeferred };
});

const { twitchPlugin, setTwitchRuntime } = await importBundledChannelContractSourceArtifact<{
  twitchPlugin: ChannelPlugin<unknown>;
  setTwitchRuntime: (runtime: PluginRuntime) => void;
}>("twitch", "api.js", {
  "@twurple/chat": () => ({
    ChatClient: transport.ChatClient,
    LogLevel: { WARNING: "warning" },
  }),
});

type Policy = { allowFrom?: string[]; allowedRoles?: string[] };
type EvidenceResult = ReturnType<typeof consumeChannelAdmissionEvidence>;

async function withTwitchMonitor(
  accountId: string,
  policy: Policy,
  run: (fixture: {
    client: InstanceType<typeof transport.ChatClient>;
    contexts: object[];
    evidence: EvidenceResult[];
    errors: string[];
    waitForReply: () => Promise<void>;
  }) => Promise<void>,
  collectionEnabled = true,
) {
  return withOpenClawTestState({ label: "twitch-provenance" }, async (state) => {
    const accountConfig = {
      username: "testbot",
      accessToken: "synthetic-test-token",
      clientId: "synthetic-client",
      channel: "testchannel",
      ...policy,
    };
    const cfg: OpenClawConfig = {
      channels: { twitch: { accounts: { [accountId]: accountConfig } } },
    };
    const account = twitchPlugin.config.resolveAccount(cfg, accountId);
    await state.writeConfig(cfg);
    const contexts: object[] = [];
    const evidence: EvidenceResult[] = [];
    const errors: string[] = [];
    const failure = transport.createDeferred<string>();
    const runtime = createPluginRuntime();
    runtime.channel.inbound.run = async (input) =>
      runChannelInboundEvent({
        ...input,
        adapter: {
          ...input.adapter,
          resolveTurn: async (...args) => {
            const turn = await input.adapter.resolveTurn(...args);
            if (!("delivery" in turn) || !turn.delivery.deliver) {
              throw new Error("Expected Twitch native reply delivery");
            }
            const delivery = turn.delivery;
            contexts.push(turn.ctxPayload);
            evidence.push(
              consumeChannelAdmissionEvidence(readChannelContextAdmissionEvidence(turn.ctxPayload)),
            );
            return {
              ...turn,
              // The real ingress queue owns adoption; outbound persistence is not this test's contract.
              delivery: { ...delivery, durable: false },
              replyResolver: async () => ({ text: "reply" }),
            };
          },
        },
      });
    const builder = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime,
      activateGlobalSideEffects: false,
    });
    const record = createPluginRecord({ id: "twitch", origin: "bundled" });
    const api = builder.createApi(record, { config: cfg, registrationMode: "full" });
    api.registerChannel({ plugin: twitchPlugin });
    builder.registry.plugins.push(record);
    markPluginRegistryActive(builder.registry);
    const registered = builder.registry.channels
      .find((entry) => entry.plugin.id === "twitch")
      ?.resolveChannelRuntime?.();
    if (!registered) {
      throw new Error("Missing registered Twitch runtime");
    }
    setTwitchRuntime(api.runtime);
    const abort = new AbortController();
    const cleanupCollection = configureChannelAdmissionEvidenceCollection(collectionEnabled);
    const ready = new Promise<InstanceType<typeof transport.ChatClient>>((resolve) => {
      transport.ChatClient.ready = resolve;
    });
    const runtimeEnv = createRuntimeEnv();
    runtimeEnv.error = (...args) => {
      const message = args.map(String).join(" ");
      errors.push(message);
      failure.resolve(message);
    };
    const ctx = {
      cfg,
      accountId,
      account,
      channelRuntime: registered,
      abortSignal: abort.signal,
      runtime: runtimeEnv,
      log: { info() {}, warn() {}, error() {}, debug() {} },
      setStatus() {},
      getStatus: () => ({ accountId }),
    };
    const start = twitchPlugin.gateway?.startAccount;
    const stop = twitchPlugin.gateway?.stopAccount;
    if (!start || !stop) {
      throw new Error("Missing Twitch account lifecycle");
    }
    const task = start(ctx);
    try {
      const client = await Promise.race([
        ready,
        task.then(() => {
          throw new Error("Twitch stopped before client registration");
        }),
      ]);
      await run({
        client,
        contexts,
        evidence,
        errors,
        waitForReply: async () => {
          const error = await Promise.race([client.sent.promise, failure.promise]);
          if (error !== undefined) {
            throw new Error(error);
          }
          expect(errors).toEqual([]);
          expect(client.say).toHaveBeenCalledExactlyOnceWith("testchannel", "reply");
        },
      });
      expect(errors).toEqual([]);
    } finally {
      abort.abort();
      await task;
      await stop(ctx);
      transport.ChatClient.ready = undefined;
      cleanupCollection();
      markPluginRegistryRetired(builder.registry);
    }
  });
}

function nativeMessage(
  userId: string | undefined = "123456",
): Parameters<InstanceType<typeof transport.ChatClient>["receive"]>[0] {
  return {
    id: crypto.randomUUID(),
    userInfo: {
      userName: "viewer",
      displayName: "Viewer",
      userId,
      isMod: true,
      isBroadcaster: false,
      isVip: false,
      isSubscriber: false,
    },
  };
}

describe("Twitch registered participant provenance", () => {
  beforeAll(async () => {
    // Load the real lazy monitor through public startup before timing individual cases.
    await withTwitchMonitor("default", {}, async () => {});
  });

  it.each(
    ["default", "secondary"].flatMap(
      (accountId) =>
        [
          { accountId, policy: { allowFrom: ["123456"] }, name: "allowlist", coverage: "enforced" },
          {
            accountId,
            policy: { allowedRoles: ["moderator"] },
            name: "role",
            coverage: "enforced",
          },
          { accountId, policy: {}, name: "open", coverage: "attribution-only" },
          {
            accountId,
            policy: { allowedRoles: ["all"] },
            name: "wildcard",
            coverage: "attribution-only",
          },
        ] satisfies { accountId: string; policy: Policy; name: string; coverage: string }[],
    ),
  )(
    "preserves $accountId $name sender through actual ingress and reply",
    async ({ accountId, policy, coverage, name }) => {
      await withTwitchMonitor(accountId, policy, async ({ client, evidence, waitForReply }) => {
        client.receive(nativeMessage());
        await waitForReply();
        expect(evidence).toEqual([
          {
            ingressState: "present",
            invoker: {
              state: "present",
              kind: "person",
              rawPrincipalRef: JSON.stringify(["twitch", accountId, "123456"]),
            },
            assuranceRef: "channel-admission",
            decisionCoverage: coverage,
            identifierAuthentication: name === "open" ? "not-evaluated" : "evaluated",
          },
        ]);
      });
    },
  );

  it("does not promote a role or username when the native user id is absent", async () => {
    await withTwitchMonitor(
      "secondary",
      { allowedRoles: ["moderator"] },
      async ({ client, evidence, waitForReply }) => {
        const message = nativeMessage();
        message.userInfo.userId = undefined;
        client.receive(message);
        await waitForReply();
        expect(evidence).toEqual([
          {
            ingressState: "unknown",
            invoker: { state: "unknown" },
            decisionCoverage: "unknown",
            identifierAuthentication: "unknown",
          },
        ]);
      },
    );
  });

  it("keeps normal replies working with collection disabled", async () => {
    await withTwitchMonitor(
      "secondary",
      { allowFrom: ["123456"] },
      async ({ client, contexts, evidence, waitForReply }) => {
        client.receive(nativeMessage());
        await waitForReply();
        const [context] = contexts;
        if (!context) {
          throw new Error("Missing admitted Twitch context");
        }
        expect(readChannelContextAdmissionEvidence(context)).toBeUndefined();
        expect(evidence).toEqual([
          {
            ingressState: "unknown",
            invoker: { state: "unknown" },
            decisionCoverage: "unknown",
            identifierAuthentication: "unknown",
          },
        ]);
      },
      false,
    );
  });
});
