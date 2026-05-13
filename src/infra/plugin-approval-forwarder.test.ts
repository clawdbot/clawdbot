import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { createExecApprovalForwarder } from "./exec-approval-forwarder.js";
import type { PluginApprovalRequest, PluginApprovalResolved } from "./plugin-approvals.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const emptyRegistry = createTestRegistry([]);
type SlackAdapterPlugin = Pick<ChannelPlugin, "id" | "meta" | "capabilities" | "config"> &
  Partial<Pick<ChannelPlugin, "approvalCapability" | "outbound">>;

const PLUGIN_TARGETS_CFG = {
  approvals: {
    plugin: {
      enabled: true,
      mode: "targets",
      targets: [{ channel: "slack", to: "U123" }],
    },
  },
} as OpenClawConfig;

const PLUGIN_DISABLED_CFG = {
  approvals: {
    plugin: {
      enabled: false,
    },
  },
} as OpenClawConfig;

function createForwarder(params: { cfg: OpenClawConfig; deliver?: ReturnType<typeof vi.fn> }) {
  const deliver = params.deliver ?? vi.fn().mockResolvedValue([]);
  const forwarder = createExecApprovalForwarder({
    getConfig: () => params.cfg,
    deliver: deliver as unknown as NonNullable<
      NonNullable<Parameters<typeof createExecApprovalForwarder>[0]>["deliver"]
    >,
    nowMs: () => 1000,
  });
  return { deliver, forwarder };
}

function makePluginRequest(overrides?: Partial<PluginApprovalRequest>): PluginApprovalRequest {
  return {
    id: "plugin-req-1",
    request: {
      pluginId: "sage",
      title: "Sensitive tool call",
      description: "The agent wants to call a sensitive tool",
      severity: "warning",
      toolName: "bash",
      agentId: "main",
      sessionKey: "agent:main:main",
    },
    createdAtMs: 1000,
    expiresAtMs: 6000,
    ...overrides,
  };
}

async function flushPendingDelivery(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

type DeliveryArgs = {
  payloads?: Array<{ text?: string; interactive?: unknown }>;
};

function deliveryArgs(deliver: ReturnType<typeof vi.fn>): DeliveryArgs | undefined {
  return deliver.mock.calls[0]?.at(0) as DeliveryArgs | undefined;
}

function firstDeliveredPayload(deliver: ReturnType<typeof vi.fn>) {
  return deliveryArgs(deliver)?.payloads?.at(0);
}

function registerSlackAdapterPlugin(plugin: SlackAdapterPlugin): void {
  const registry = createTestRegistry([{ pluginId: "slack", plugin, source: "test" }]);
  setActivePluginRegistry(registry);
}

function createSlackAdapterPlugin(overrides: Partial<SlackAdapterPlugin>): SlackAdapterPlugin {
  return {
    ...createChannelTestPluginBase({ id: "slack" as ChannelPlugin["id"] }),
    ...overrides,
  };
}

async function registerPendingApproval(
  forwarder: ReturnType<typeof createForwarder>["forwarder"],
  deliver: ReturnType<typeof vi.fn>,
): Promise<void> {
  await forwarder.handlePluginApprovalRequested!(makePluginRequest());
  await flushPendingDelivery();
  expect(deliver).toHaveBeenCalled();
  deliver.mockClear();
}

function makePluginResolved(overrides?: Partial<PluginApprovalResolved>): PluginApprovalResolved {
  return {
    id: "plugin-req-1",
    decision: "allow-once",
    resolvedBy: "telegram:user123",
    ts: 2000,
    ...overrides,
  };
}

describe("plugin approval forwarding", () => {
  beforeEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  describe("handlePluginApprovalRequested", () => {
    it("returns false when forwarding is disabled", async () => {
      const { forwarder } = createForwarder({ cfg: PLUGIN_DISABLED_CFG });
      const result = await forwarder.handlePluginApprovalRequested!(makePluginRequest());
      expect(result).toBe(false);
    });

    it("forwards to configured targets", async () => {
      const deliver = vi.fn().mockResolvedValue([]);
      const { forwarder } = createForwarder({ cfg: PLUGIN_TARGETS_CFG, deliver });
      const result = await forwarder.handlePluginApprovalRequested!(makePluginRequest());
      expect(result).toBe(true);
      await flushPendingDelivery();
      expect(deliver).toHaveBeenCalled();
      const payload = firstDeliveredPayload(deliver);
      const text = payload?.text ?? "";
      expect(text).toContain("Plugin approval required");
      expect(text).toContain("Sensitive tool call");
      expect(text).toContain("plugin-req-1");
      expect(text).toContain("/approve");
      expect(payload?.interactive).toEqual({
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Allow Once",
                value: "/approve plugin-req-1 allow-once",
                style: "success",
              },
              {
                label: "Allow Always",
                value: "/approve plugin-req-1 allow-always",
                style: "primary",
              },
              {
                label: "Deny",
                value: "/approve plugin-req-1 deny",
                style: "danger",
              },
            ],
          },
        ],
      });
    });

    it("renders only request-scoped plugin approval decisions", async () => {
      const deliver = vi.fn().mockResolvedValue([]);
      const { forwarder } = createForwarder({ cfg: PLUGIN_TARGETS_CFG, deliver });
      const result = await forwarder.handlePluginApprovalRequested!(
        makePluginRequest({
          request: {
            ...makePluginRequest().request,
            allowedDecisions: ["allow-once", "deny"],
          },
        }),
      );
      expect(result).toBe(true);
      await flushPendingDelivery();
      const payload = firstDeliveredPayload(deliver);
      expect(payload?.text).toContain("Reply with: /approve <id> allow-once|deny");
      expect(payload?.text).not.toContain("allow-always");
      expect(payload?.interactive).toEqual({
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Allow Once",
                value: "/approve plugin-req-1 allow-once",
                style: "success",
              },
              {
                label: "Deny",
                value: "/approve plugin-req-1 deny",
                style: "danger",
              },
            ],
          },
        ],
      });
    });

    it("includes severity icon for critical", async () => {
      const deliver = vi.fn().mockResolvedValue([]);
      const { forwarder } = createForwarder({ cfg: PLUGIN_TARGETS_CFG, deliver });
      const request = makePluginRequest();
      request.request.severity = "critical";
      await forwarder.handlePluginApprovalRequested!(request);
      await flushPendingDelivery();
      expect(deliver).toHaveBeenCalled();
      const text = firstDeliveredPayload(deliver)?.text ?? "";
      expect(text).toMatch(/🚨/);
    });

    it("returns false when exec enabled but plugin disabled", async () => {
      const cfg = {
        approvals: {
          exec: { enabled: true, mode: "targets", targets: [{ channel: "slack", to: "U123" }] },
          plugin: { enabled: false },
        },
      } as OpenClawConfig;
      const { forwarder } = createForwarder({ cfg });
      const result = await forwarder.handlePluginApprovalRequested!(makePluginRequest());
      expect(result).toBe(false);
    });

    it("forwards when plugin enabled but exec disabled", async () => {
      const cfg = {
        approvals: {
          exec: { enabled: false },
          plugin: {
            enabled: true,
            mode: "targets",
            targets: [{ channel: "slack", to: "U123" }],
          },
        },
      } as OpenClawConfig;
      const deliver = vi.fn().mockResolvedValue([]);
      const { forwarder } = createForwarder({ cfg, deliver });
      const result = await forwarder.handlePluginApprovalRequested!(makePluginRequest());
      expect(result).toBe(true);
      await flushPendingDelivery();
      expect(deliver).toHaveBeenCalled();
    });

    it("returns false when no approvals config at all", async () => {
      const cfg = {} as OpenClawConfig;
      const { forwarder } = createForwarder({ cfg });
      const result = await forwarder.handlePluginApprovalRequested!(makePluginRequest());
      expect(result).toBe(false);
    });
  });

  describe("channel adapter hooks", () => {
    it("uses buildPluginPendingPayload from channel adapter when available", async () => {
      const mockPayload = { text: "custom adapter payload" };
      registerSlackAdapterPlugin(
        createSlackAdapterPlugin({
          approvalCapability: {
            render: {
              plugin: {
                buildPendingPayload: vi.fn().mockReturnValue(mockPayload),
              },
            },
          },
        }),
      );

      const deliver = vi.fn().mockResolvedValue([]);
      const { forwarder } = createForwarder({ cfg: PLUGIN_TARGETS_CFG, deliver });
      await forwarder.handlePluginApprovalRequested!(makePluginRequest());
      await flushPendingDelivery();
      expect(deliver).toHaveBeenCalled();
      expect(firstDeliveredPayload(deliver)?.text).toBe("custom adapter payload");
    });

    it("calls outbound beforeDeliverPayload before plugin approval delivery", async () => {
      const beforeDeliverPayload = vi.fn();
      registerSlackAdapterPlugin(
        createSlackAdapterPlugin({
          outbound: {
            deliveryMode: "direct",
            beforeDeliverPayload,
          },
        }),
      );

      const deliver = vi.fn().mockResolvedValue([]);
      const { forwarder } = createForwarder({ cfg: PLUGIN_TARGETS_CFG, deliver });
      await forwarder.handlePluginApprovalRequested!(makePluginRequest());
      await flushPendingDelivery();
      expect(deliver).toHaveBeenCalled();
      expect(beforeDeliverPayload).toHaveBeenCalled();
    });

    it("uses buildPluginResolvedPayload from channel adapter for resolved messages", async () => {
      const mockPayload = { text: "custom resolved payload" };
      registerSlackAdapterPlugin(
        createSlackAdapterPlugin({
          approvalCapability: {
            render: {
              plugin: {
                buildResolvedPayload: vi.fn().mockReturnValue(mockPayload),
              },
            },
          },
        }),
      );

      const deliver = vi.fn().mockResolvedValue([]);
      const { forwarder } = createForwarder({ cfg: PLUGIN_TARGETS_CFG, deliver });

      await registerPendingApproval(forwarder, deliver);

      await forwarder.handlePluginApprovalResolved!(makePluginResolved());
      await flushPendingDelivery();
      expect(deliver).toHaveBeenCalled();
      expect(firstDeliveredPayload(deliver)?.text).toBe("custom resolved payload");
    });
  });

  describe("handlePluginApprovalResolved", () => {
    it("delivers resolved message to targets", async () => {
      const deliver = vi.fn().mockResolvedValue([]);
      const { forwarder } = createForwarder({ cfg: PLUGIN_TARGETS_CFG, deliver });

      await registerPendingApproval(forwarder, deliver);

      await forwarder.handlePluginApprovalResolved!(makePluginResolved());
      expect(deliver).toHaveBeenCalled();
      const text = firstDeliveredPayload(deliver)?.text ?? "";
      expect(text).toContain("Plugin approval");
      expect(text).toContain("allowed once");
    });

    it("reconstructs targets from resolved request snapshot when pending cache is missing", async () => {
      const deliver = vi.fn().mockResolvedValue([]);
      const { forwarder } = createForwarder({ cfg: PLUGIN_TARGETS_CFG, deliver });

      await forwarder.handlePluginApprovalResolved!({
        id: "plugin-req-late",
        decision: "deny",
        resolvedBy: "telegram:user123",
        ts: 2_000,
        request: {
          pluginId: "sage",
          title: "Sensitive tool call",
          description: "The agent wants to call a sensitive tool",
          severity: "warning",
          toolName: "bash",
          agentId: "main",
          sessionKey: "agent:main:main",
        },
      });

      expect(deliver).toHaveBeenCalled();
      const text = firstDeliveredPayload(deliver)?.text ?? "";
      expect(text).toContain("Plugin approval");
      expect(text).toContain("denied");
    });
  });

  describe("stop", () => {
    it("clears pending plugin approvals", async () => {
      const deliver = vi.fn().mockResolvedValue([]);
      const { forwarder } = createForwarder({ cfg: PLUGIN_TARGETS_CFG, deliver });
      await forwarder.handlePluginApprovalRequested!(makePluginRequest());
      await flushPendingDelivery();
      expect(deliver).toHaveBeenCalled();
      forwarder.stop();
      deliver.mockClear();
      // After stop, resolved should not deliver
      await forwarder.handlePluginApprovalResolved!({
        id: "plugin-req-1",
        decision: "deny",
        ts: 2000,
      });
      expect(deliver).not.toHaveBeenCalled();
    });
  });
});
