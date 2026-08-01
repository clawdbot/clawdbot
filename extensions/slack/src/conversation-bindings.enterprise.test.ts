// Slack tests cover account-scoped runtime conversation binding admission.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeOpenClawStateDatabaseForTest } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  createTestRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  getSessionBindingService,
  testing as sessionBindingTesting,
} from "openclaw/plugin-sdk/session-binding-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { slackPlugin } from "./channel.js";
import type { OpenClawConfig } from "./runtime-api.js";
import { setSlackRuntime } from "./runtime.js";

const CONVERSATION = {
  channel: "slack",
  accountId: "default",
  conversationId: "channel:C123",
};

describe("Slack Enterprise Grid runtime conversation bindings", () => {
  let cfg: OpenClawConfig;
  let previousStateDir: string | undefined;
  let testStateDir = "";

  beforeEach(async () => {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    testStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-slack-bindings-"));
    process.env.OPENCLAW_STATE_DIR = testStateDir;
    cfg = { channels: { slack: {} } };
    setSlackRuntime({ config: { current: () => cfg } } as never);
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "slack", source: "test", plugin: slackPlugin }]),
    );
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
  });

  afterEach(async () => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    closeOpenClawStateDatabaseForTest();
    setSlackRuntime(null as never);
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await fs.rm(testStateDir, { recursive: true, force: true });
  });

  it("preserves workspace capability and binding mutations", async () => {
    const service = getSessionBindingService();
    expect(service.getCapabilities({ channel: " Slack ", accountId: " DEFAULT " })).toEqual({
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current"],
    });

    const first = await service.bind({
      targetSessionKey: "agent:main:first",
      targetKind: "session",
      conversation: CONVERSATION,
    });
    service.touch(first.bindingId, 1234);
    expect(service.resolveByConversation(CONVERSATION)?.metadata?.lastActivityAt).toBe(1234);

    const reassigned = await service.bind({
      targetSessionKey: "agent:main:second",
      targetKind: "session",
      conversation: CONVERSATION,
    });
    expect(reassigned.targetSessionKey).toBe("agent:main:second");
    await expect(
      service.unbind({ bindingId: reassigned.bindingId, reason: "workspace cleanup" }),
    ).resolves.toEqual([reassigned]);
  });

  it("does not advertise, select, or mutate bindings for an enterprise account", async () => {
    const service = getSessionBindingService();
    const existing = await service.bind({
      targetSessionKey: "agent:main:workspace",
      targetKind: "session",
      conversation: CONVERSATION,
    });
    const originalActivityAt = existing.metadata?.lastActivityAt;
    cfg = { channels: { slack: { enterpriseOrgInstall: true } } };

    expect(service.getCapabilities({ channel: "slack", accountId: "default" })).toEqual({
      adapterAvailable: false,
      bindSupported: false,
      unbindSupported: false,
      placements: [],
    });
    expect(service.resolveByConversation(CONVERSATION)).toBeNull();
    expect(service.listBySession("agent:main:workspace")).toEqual([]);

    service.touch(existing.bindingId, 9999);
    await expect(
      service.bind({
        targetSessionKey: "agent:main:enterprise",
        targetKind: "session",
        conversation: CONVERSATION,
      }),
    ).rejects.toMatchObject({ code: "BINDING_ADAPTER_UNAVAILABLE" });
    await expect(
      service.bind({
        targetSessionKey: "agent:main:new-enterprise",
        targetKind: "session",
        conversation: { ...CONVERSATION, conversationId: "channel:C456" },
      }),
    ).rejects.toMatchObject({ code: "BINDING_ADAPTER_UNAVAILABLE" });
    await expect(
      service.unbind({ bindingId: existing.bindingId, reason: "enterprise cleanup" }),
    ).resolves.toEqual([]);
    await expect(
      service.unbind({ targetSessionKey: existing.targetSessionKey, reason: "enterprise cleanup" }),
    ).resolves.toEqual([]);

    cfg = { channels: { slack: {} } };
    expect(service.resolveByConversation(CONVERSATION)).toMatchObject({
      bindingId: existing.bindingId,
      targetSessionKey: "agent:main:workspace",
      metadata: { lastActivityAt: originalActivityAt },
    });
  });
});
