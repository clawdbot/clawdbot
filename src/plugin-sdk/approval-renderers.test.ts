/**
 * Tests approval renderer payload and text formatting.
 */
import { describe, expect, it } from "vitest";
import {
  buildApprovalPendingReplyPayload,
  buildApprovalResolvedReplyPayload,
  buildPluginApprovalPendingReplyPayload,
  buildPluginApprovalResolvedReplyPayload,
  buildTypedApprovalPendingReplyPayload,
  buildTypedPluginApprovalPendingReplyPayload,
} from "./approval-renderers.js";

describe("plugin-sdk/approval-renderers", () => {
  it("preserves command controls when shipped approvalKind metadata is supplied", () => {
    expect(
      buildApprovalPendingReplyPayload({
        approvalKind: "plugin",
        approvalId: "plugin:legacy-approval",
        approvalSlug: "legacy-a",
        text: "Approval required",
        allowedDecisions: ["deny"],
      }),
    ).toEqual({
      text: "Approval required",
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Deny",
                action: { type: "command", command: "/approve plugin:legacy-approval deny" },
                value: "/approve plugin:legacy-approval deny",
                style: "danger",
              },
            ],
          },
        ],
      },
      channelData: {
        execApproval: {
          approvalId: "plugin:legacy-approval",
          approvalSlug: "legacy-a",
          approvalKind: "plugin",
          agentId: undefined,
          allowedDecisions: ["deny"],
          sessionKey: undefined,
          state: "pending",
        },
      },
    });
  });

  it("preserves command controls in the shipped plugin approval builder", () => {
    const payload = buildPluginApprovalPendingReplyPayload({
      request: {
        id: "plugin-legacy",
        request: {
          title: "Sensitive action",
          description: "Needs approval",
          allowedDecisions: ["allow-once"],
        },
        createdAtMs: 1_000,
        expiresAtMs: 61_000,
      },
      nowMs: 1_000,
    });

    expect(payload.text).toContain("Reply with: /approve plugin-legacy allow-once");
    expect(payload.text).not.toContain("allow-once|deny");
    expect(payload.presentation).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Allow Once",
              action: { type: "command", command: "/approve plugin-legacy allow-once" },
              value: "/approve plugin-legacy allow-once",
              style: "success",
            },
          ],
        },
      ],
    });
  });

  it.each([
    {
      name: "builds shared approval payloads with typed plugin decisions",
      payload: buildTypedApprovalPendingReplyPayload({
        approvalKind: "plugin",
        approvalId: "plugin:approval-123",
        approvalSlug: "plugin:a",
        text: "Approval required @everyone",
      }),
      textExpected: (text: string) => expect(text).toContain("@everyone"),
      presentationExpected: {
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Allow Once",
                action: {
                  type: "approval",
                  approvalId: "plugin:approval-123",
                  approvalKind: "plugin",
                  decision: "allow-once",
                },
                style: "success",
              },
              {
                label: "Allow Always",
                action: {
                  type: "approval",
                  approvalId: "plugin:approval-123",
                  approvalKind: "plugin",
                  decision: "allow-always",
                },
                style: "primary",
              },
              {
                label: "Deny",
                action: {
                  type: "approval",
                  approvalId: "plugin:approval-123",
                  approvalKind: "plugin",
                  decision: "deny",
                },
                style: "danger",
              },
            ],
          },
        ],
      },
      channelDataExpected: undefined,
    },
    {
      name: "builds plugin pending payloads with approval metadata and extra channel data",
      payload: buildTypedPluginApprovalPendingReplyPayload({
        request: {
          id: "plugin-approval-123",
          request: {
            title: "Sensitive action",
            description: "Needs approval",
          },
          createdAtMs: 1_000,
          expiresAtMs: 61_000,
        },
        nowMs: 1_000,
        approvalSlug: "custom-slug",
        channelData: {
          telegram: {
            quoteText: "quoted",
          },
        },
      }),
      textExpected: (text: string) => expect(text).toContain("Plugin approval required"),
      presentationExpected: {
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Allow Once",
                action: {
                  type: "approval",
                  approvalId: "plugin-approval-123",
                  approvalKind: "plugin",
                  decision: "allow-once",
                },
                style: "success",
              },
              {
                label: "Allow Always",
                action: {
                  type: "approval",
                  approvalId: "plugin-approval-123",
                  approvalKind: "plugin",
                  decision: "allow-always",
                },
                style: "primary",
              },
              {
                label: "Deny",
                action: {
                  type: "approval",
                  approvalId: "plugin-approval-123",
                  approvalKind: "plugin",
                  decision: "deny",
                },
                style: "danger",
              },
            ],
          },
        ],
      },
      channelDataExpected: {
        execApproval: {
          agentId: undefined,
          approvalId: "plugin-approval-123",
          approvalKind: "plugin",
          approvalSlug: "custom-slug",
          allowedDecisions: ["allow-once", "allow-always", "deny"],
          sessionKey: undefined,
          state: "pending",
        },
        telegram: {
          quoteText: "quoted",
        },
      },
    },
    {
      name: "adds fail-closed deny to request-scoped plugin decisions",
      payload: buildTypedPluginApprovalPendingReplyPayload({
        request: {
          id: "plugin-approval-123",
          request: {
            title: "Sensitive action",
            description: "Needs approval",
            allowedDecisions: ["allow-once"],
          },
          createdAtMs: 1_000,
          expiresAtMs: 61_000,
        },
        nowMs: 1_000,
        allowedDecisions: ["allow-once"],
      }),
      textExpected: (text: string) => {
        expect(text).toContain("Reply with: /approve plugin-approval-123 allow-once");
        expect(text).not.toContain("allow-once|deny");
      },
      presentationExpected: {
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Allow Once",
                action: {
                  type: "approval",
                  approvalId: "plugin-approval-123",
                  approvalKind: "plugin",
                  decision: "allow-once",
                },
                style: "success",
              },
              {
                label: "Deny",
                action: {
                  type: "approval",
                  approvalId: "plugin-approval-123",
                  approvalKind: "plugin",
                  decision: "deny",
                },
                style: "danger",
              },
            ],
          },
        ],
      },
      channelDataExpected: {
        execApproval: {
          agentId: undefined,
          approvalId: "plugin-approval-123",
          approvalKind: "plugin",
          approvalSlug: "plugin-a",
          allowedDecisions: ["allow-once", "deny"],
          sessionKey: undefined,
          state: "pending",
        },
      },
    },
    {
      name: "builds generic resolved payloads with approval metadata",
      payload: buildApprovalResolvedReplyPayload({
        approvalId: "req-123",
        approvalSlug: "req-123",
        text: "resolved @everyone",
      }),
      textExpected: (text: string) => expect(text).toBe("resolved @everyone"),
      presentationExpected: undefined,
      channelDataExpected: {
        execApproval: {
          approvalId: "req-123",
          approvalSlug: "req-123",
          state: "resolved",
        },
      },
    },
    {
      name: "builds plugin resolved payloads with optional channel data",
      payload: buildPluginApprovalResolvedReplyPayload({
        resolved: {
          id: "plugin-approval-123",
          decision: "allow-once",
          resolvedBy: "discord:user:1",
          ts: 2_000,
        },
        channelData: {
          discord: {
            components: [{ type: "container" }],
          },
        },
      }),
      textExpected: (text: string) => expect(text).toContain("Plugin approval allowed once"),
      presentationExpected: undefined,
      channelDataExpected: {
        execApproval: {
          approvalId: "plugin-approval-123",
          approvalSlug: "plugin-a",
          state: "resolved",
        },
        discord: {
          components: [{ type: "container" }],
        },
      },
    },
  ])("$name", ({ payload, textExpected, presentationExpected, channelDataExpected }) => {
    if (payload.text === undefined) {
      throw new Error("expected rendered approval text");
    }
    textExpected(payload.text);
    if (presentationExpected) {
      expect(payload.presentation).toEqual(presentationExpected);
      expect(payload.interactive).toBeUndefined();
    }
    if (channelDataExpected) {
      expect(payload.channelData).toEqual(channelDataExpected);
    }
  });
});
