import { expectDefined } from "@openclaw/normalization-core";
import {
  createEmptyPluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  getSessionBindingService,
  resolveRuntimeConversationBindingRoute,
} from "openclaw/plugin-sdk/conversation-binding-runtime";
import { resolvePluginConversationBindingApproval } from "openclaw/plugin-sdk/conversation-runtime";
import { createInteractiveConversationBindingHelpers } from "openclaw/plugin-sdk/plugin-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createFeishuThreadBindingManager } from "./thread-bindings.js";

beforeEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
});

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

it("approves, routes, and detaches an opaque Feishu plugin target without inventing an agent owner", async () => {
  await withStateDirEnv("feishu-plugin-binding-", async ({ tempRoot }) => {
    const cfg = {
      agents: { entries: { alpha: {}, beta: {} } },
      bindings: [{ agentId: "alpha", match: { channel: "feishu" } }],
    } satisfies OpenClawConfig;
    const manager = createFeishuThreadBindingManager({ cfg, accountId: "default" });
    const owner = { pluginId: "fixture-runtime", pluginRoot: tempRoot };
    const conversation = {
      channel: "feishu",
      accountId: "default",
      conversationId: "oc_group:topic:om_root",
      parentConversationId: "oc_group",
    };
    const binding = { summary: "Plugin-owned thread", data: { externalThread: "thread-17" } };
    const helpers = createInteractiveConversationBindingHelpers({
      registration: owner,
      senderId: "user-1",
      conversation,
    });
    try {
      const requested = await helpers.requestConversationBinding(binding);
      expect(requested.status).toBe("pending");
      if (requested.status !== "pending") {
        throw new Error("Expected a plugin binding approval request");
      }
      await expect(
        resolvePluginConversationBindingApproval({
          approvalId: requested.approvalId,
          decision: "allow-once",
          senderId: "user-1",
        }),
      ).resolves.toMatchObject({ status: "approved", binding: { ...owner, ...binding } });

      const approvedRecord = expectDefined(
        getSessionBindingService().resolveByConversation(conversation),
        "approved Feishu plugin binding",
      );
      const record = await getSessionBindingService().bind({
        conversation,
        targetSessionKey: approvedRecord.targetSessionKey,
        targetKind: approvedRecord.targetKind,
      });
      expect(record.targetSessionKey).toMatch(/^plugin-binding:fixture-runtime:/);
      expect(record.metadata?.agentId).toBeUndefined();
      const route = resolveAgentRoute({
        cfg,
        channel: "feishu",
        accountId: "default",
        peer: { kind: "group", id: conversation.conversationId },
      });
      expect(resolveRuntimeConversationBindingRoute({ route, conversation })).toMatchObject({
        pluginId: owner.pluginId,
        route,
        bindingRecord: record,
      });
      await expect(helpers.getCurrentConversationBinding()).resolves.toMatchObject({
        ...owner,
        ...binding,
      });
      await expect(helpers.detachConversationBinding()).resolves.toEqual({ removed: true });
      expect(getSessionBindingService().resolveByConversation(conversation)).toBeNull();
    } finally {
      manager.stop();
    }
  });
});
