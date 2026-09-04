import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpxRuntime, createAgentRegistry, createFileSessionStore } from "acpx/runtime";
import {
  getAcpSessionManager,
  registerAcpRuntimeBackend,
  testing as acpRuntimeTesting,
  unregisterAcpRuntimeBackend,
} from "openclaw/plugin-sdk/acp-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  registerSessionBindingAdapter,
  testing as sessionBindingTesting,
  type SessionBindingBindInput,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/conversation-runtime";
import { createAdmittedHostCapabilityTestFixture } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it } from "vitest";
import { validateAcpResumeSessionOwnership } from "../../agents/subagents/spawn/acp-spawn-requester.js";
import { handleAcpSpawnAction } from "../../auto-reply/reply/commands-acp/lifecycle.js";
import { buildCommandTestParams } from "../../auto-reply/reply/commands-spawn.test-harness.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";

const harness = "owner-fixture";
const script = fileURLToPath(
  new URL("../../../extensions/acpx/test/fixtures/owner-agent.mjs", import.meta.url),
);

function registerInMemoryDiscordBindings(): SessionBindingRecord[] {
  const bindings: SessionBindingRecord[] = [];
  registerSessionBindingAdapter({
    channel: "discord",
    accountId: "owner-account",
    capabilities: {
      placements: ["current"],
      bindSupported: true,
      unbindSupported: true,
    },
    bind: async (input: SessionBindingBindInput) => {
      const record = {
        bindingId: `discord:owner-account:${input.conversation.conversationId}`,
        targetSessionKey: input.targetSessionKey,
        targetKind: input.targetKind,
        conversation: input.conversation,
        status: "active",
        boundAt: 1,
        ...(input.metadata ? { metadata: input.metadata } : {}),
      } satisfies SessionBindingRecord;
      bindings.push(record);
      return record;
    },
    listBySession: (targetSessionKey) =>
      bindings.filter((entry) => entry.targetSessionKey === targetSessionKey),
    resolveByConversation: (ref) =>
      bindings.find(
        (entry) =>
          entry.conversation.channel === ref.channel &&
          entry.conversation.accountId === ref.accountId &&
          entry.conversation.conversationId === ref.conversationId,
      ) ?? null,
    unbind: async ({ bindingId, targetSessionKey }) =>
      bindings.filter(
        (entry) =>
          (bindingId && entry.bindingId === bindingId) ||
          (targetSessionKey && entry.targetSessionKey === targetSessionKey),
      ),
  });
  return bindings;
}

it("runs a configured alias through real ACPX and rejects a foreign resume before process I/O", async () => {
  await withOpenClawTestState({ label: "acpx-alias-owner-process" }, async (state) => {
    const ownerWorkspace = path.join(state.root, "owner-workspace");
    const peerDirectory = path.join(state.root, "peer");
    await fs.mkdir(ownerWorkspace);
    await fs.mkdir(peerDirectory);
    const cfg = {
      acp: {
        enabled: true,
        backend: "acpx",
        defaultAgent: "reviewer",
        allowedAgents: [harness],
      },
      agents: {
        ownership: "explicit" as const,
        defaults: { systemAgent: { agentId: "main" } },
        entries: {
          main: {},
          reviewer: {
            workspace: ownerWorkspace,
            runtime: { type: "acp" as const, acp: { agent: harness, backend: "acpx" } },
          },
        },
      },
      session: {
        scope: "per-sender" as const,
        store: path.join(state.root, "agents", "{agentId}", "sessions.json"),
        threadBindings: { enabled: true },
      },
    } satisfies OpenClawConfig;
    await state.writeConfig(cfg);

    const runtime = new AcpxRuntime({
      cwd: state.root,
      sessionStore: createFileSessionStore({ stateDir: state.root }),
      agentRegistry: createAgentRegistry({
        overrides: { [harness]: [process.execPath, script, peerDirectory] },
      }),
      pluginToolsMcpBridgeEnabled: true,
      openclawToolsMcpBridgeEnabled: true,
      mcpServers: [],
      permissionMode: "deny-all",
      timeoutMs: 5_000,
    });
    registerAcpRuntimeBackend({ id: "acpx", runtime });
    acpRuntimeTesting.resetAcpSessionManagerForTests();
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    const registrySnapshot = captureActivePluginRegistrySnapshot();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "discord",
          source: "test",
          plugin: createChannelTestPluginBase({ id: "discord", label: "Discord" }),
        },
      ]),
    );
    const bindings = registerInMemoryDiscordBindings();
    const manager = getAcpSessionManager();
    let sessionKey: string | undefined;
    try {
      const commandParams = buildCommandTestParams("/acp spawn reviewer --bind here", cfg, {
        Provider: "discord",
        Surface: "discord",
        OriginatingChannel: "discord",
        OriginatingTo: "channel:owner-room",
        AccountId: "owner-account",
        SenderId: "owner-user",
        SessionKey: "agent:main:main",
      });
      commandParams.command.senderId = "owner-user";
      const spawned = await handleAcpSpawnAction(commandParams, ["reviewer", "--bind", "here"]);
      const match = spawned.reply?.text?.match(/Spawned ACP session (agent:[^ ]+)/);
      sessionKey = match?.[1];
      expect(sessionKey).toMatch(/^agent:reviewer:acp:/);
      expect(spawned.reply?.text).toContain("Bound this conversation");
      expect(bindings).toEqual([
        expect.objectContaining({
          targetSessionKey: sessionKey,
          conversation: expect.objectContaining({
            channel: "discord",
            accountId: "owner-account",
            conversationId: "owner-room",
          }),
          metadata: expect.objectContaining({
            agentId: "reviewer",
            introText: expect.stringContaining(`cwd: ${ownerWorkspace}`),
          }),
        }),
      ]);

      const target = { cfg, sessionKey: sessionKey!, agentId: "reviewer" };
      const status = await manager.getSessionStatus(target);
      expect(status).toMatchObject({
        agentId: "reviewer",
        sessionKey,
      });

      const admission = await createAdmittedHostCapabilityTestFixture({
        config: cfg,
        runId: "alias-owner-proof",
        agentId: "reviewer",
        sessionId: "reviewer-session",
        sessionKey: sessionKey!,
        workspaceDir: ownerWorkspace,
        abortSignal: new AbortController().signal,
      });
      const chunks: string[] = [];
      try {
        await manager.runTurn({
          ...target,
          admittedRunContext: admission.admittedRunContext,
          provenance: "human",
          text: "owner-proof",
          mode: "prompt",
          requestId: "alias-owner-proof",
          onEvent(event) {
            if (event.type === "text_delta") {
              chunks.push(event.text);
            }
          },
        });
      } finally {
        admission.closeHost();
        admission.closeAdmission();
      }
      expect(JSON.parse(chunks.join(""))).toMatchObject({ history: ["owner-proof"] });
      const resumedStatus = await manager.getSessionStatus(target);
      const resumeSessionId =
        resumedStatus.identity?.agentSessionId ?? resumedStatus.identity?.acpxSessionId;
      expect(resumeSessionId).toBeTruthy();
      const peerFiles = await fs.readdir(peerDirectory);
      expect(peerFiles).toHaveLength(1);
      const peerFile = path.join(peerDirectory, peerFiles[0]!);
      const peerStateBeforeForeignResume = await fs.readFile(peerFile, "utf8");
      await expect(
        validateAcpResumeSessionOwnership({
          cfg,
          sessionOwnerAgentId: "reviewer",
          harnessAgentId: harness,
          backendId: "acpx",
          requesterSessionKey: "agent:foreign:main",
          resumeSessionId,
        }),
      ).resolves.toMatchObject({ ok: false });
      expect(await fs.readFile(peerFile, "utf8")).toBe(peerStateBeforeForeignResume);
      await manager.setSessionRuntimeMode({ ...target, runtimeMode: "review" });
      await manager.cancelSession(target);
      await manager.closeSession({ ...target, reason: "test-complete" });
    } finally {
      if (sessionKey) {
        await manager
          .closeSession({
            cfg,
            sessionKey,
            agentId: "reviewer",
            reason: "test-cleanup",
            requireAcpSession: false,
          })
          .catch(() => {});
      }
      restoreActivePluginRegistrySnapshot(registrySnapshot);
      sessionBindingTesting.resetSessionBindingAdaptersForTests();
      acpRuntimeTesting.resetAcpSessionManagerForTests();
      unregisterAcpRuntimeBackend("acpx");
    }
  });
});
