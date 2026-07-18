// Discord tests cover shared interactive plugin behavior.
import { buildApprovalResolutionRef } from "openclaw/plugin-sdk/approval-reference-runtime";
import type {
  MessagePresentation,
  MessagePresentationAction,
} from "openclaw/plugin-sdk/interactive-runtime";
import { describe, expect, it } from "vitest";
import { parseExecApprovalData } from "./approval-custom-id.js";
import { buildDiscordActivityCustomId } from "./component-custom-id.js";
import { buildDiscordComponentMessage } from "./components.js";
import { parseCustomId } from "./internal/discord.js";
import {
  buildDiscordInteractiveComponents,
  buildDiscordPresentationComponents,
} from "./shared-interactive.js";

describe("buildDiscordInteractiveComponents", () => {
  it("maps shared buttons and selects into Discord component blocks", () => {
    expect(
      buildDiscordInteractiveComponents({
        blocks: [
          {
            type: "buttons",
            buttons: [
              { label: "Approve", value: "approve", style: "success" },
              { label: "Reject", value: "reject", style: "danger" },
            ],
          },
          {
            type: "select",
            placeholder: "Pick one",
            options: [{ label: "Alpha", value: "alpha" }],
          },
        ],
      }),
    ).toEqual({
      blocks: [
        {
          type: "actions",
          buttons: [
            { label: "Approve", style: "success", callbackData: "approve" },
            { label: "Reject", style: "danger", callbackData: "reject" },
          ],
        },
        {
          type: "actions",
          select: {
            type: "string",
            placeholder: "Pick one",
            options: [{ label: "Alpha", value: "alpha" }],
          },
        },
      ],
    });
  });

  it("preserves authored shared text blocks around controls", () => {
    expect(
      buildDiscordInteractiveComponents({
        blocks: [
          { type: "text", text: "First" },
          {
            type: "buttons",
            buttons: [{ label: "Approve", value: "approve", style: "success" }],
          },
          { type: "text", text: "Last" },
        ],
      }),
    ).toEqual({
      blocks: [
        { type: "text", text: "First" },
        {
          type: "actions",
          buttons: [{ label: "Approve", style: "success", callbackData: "approve" }],
        },
        { type: "text", text: "Last" },
      ],
    });
  });

  it("preserves URL-only buttons as Discord link buttons", () => {
    expect(
      buildDiscordInteractiveComponents({
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Docs", url: "https://example.com/docs" }],
          },
        ],
      }),
    ).toEqual({
      blocks: [
        {
          type: "actions",
          buttons: [{ label: "Docs", style: "link", url: "https://example.com/docs" }],
        },
      ],
    });
  });

  it.each(["url", "web-app"] as const)(
    "renders typed %s actions as Discord link buttons",
    (type) => {
      expect(
        buildDiscordPresentationComponents({
          blocks: [
            {
              type: "buttons",
              buttons: [
                {
                  label: "Review",
                  action: { type, url: "https://example.com/review" } as MessagePresentationAction,
                },
              ],
            },
          ],
        }),
      ).toEqual({
        blocks: [
          {
            type: "actions",
            buttons: [
              {
                label: "Review",
                style: "link",
                url: "https://example.com/review",
              },
            ],
          },
        ],
      });
    },
  );

  it("renders hosted widget actions as Discord Activity buttons", () => {
    const widgetId = "AAAAAAAAAAAAAAAAAAAAAA";
    expect(
      buildDiscordPresentationComponents({
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Open widget",
                action: { type: "web-app", widgetId },
              },
            ],
          },
        ],
      }),
    ).toEqual({
      blocks: [
        {
          type: "actions",
          buttons: [
            {
              label: "Open widget",
              style: "secondary",
              internalCustomId: buildDiscordActivityCustomId(widgetId),
            },
          ],
        },
      ],
    });
  });

  it("falls back to a web-app URL when the hosted widget id is invalid", () => {
    expect(
      buildDiscordPresentationComponents({
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Open app",
                action: {
                  type: "web-app",
                  widgetId: "invalid",
                  url: "https://example.com/app",
                },
              },
            ],
          },
        ],
      }),
    ).toEqual({
      blocks: [
        {
          type: "actions",
          buttons: [
            {
              label: "Open app",
              style: "link",
              url: "https://example.com/app",
            },
          ],
        },
      ],
    });
  });

  it("skips web-app actions without a renderable Discord target", () => {
    const presentation = {
      blocks: [
        {
          type: "buttons" as const,
          buttons: [
            { label: "Missing", action: { type: "web-app" } },
            { label: "Invalid", action: { type: "web-app", widgetId: "invalid" } },
          ],
        },
      ],
    } as unknown as MessagePresentation;
    expect(buildDiscordPresentationComponents(presentation)).toBeUndefined();
  });

  it("renders typed approvals as actionable transport-private Discord controls", () => {
    const rendered = buildDiscordPresentationComponents({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Deny",
              action: {
                type: "approval",
                approvalId: "opaque:approval;id=7",
                approvalKind: "plugin",
                decision: "deny",
              },
              value: "/approve opaque:approval;id=7 deny",
              style: "danger",
            },
          ],
        },
      ],
    });

    expect(rendered).toEqual({
      blocks: [
        {
          type: "actions",
          buttons: [
            {
              label: "Deny",
              style: "danger",
              internalCustomId:
                "execapproval:kind=plugin;id=opaque%3Aapproval%3Bid%3D7;action=deny",
            },
          ],
        },
      ],
    });
    const firstBlock = rendered?.blocks?.[0];
    const customId =
      firstBlock?.type === "actions" ? firstBlock.buttons?.[0]?.internalCustomId : undefined;
    expect(customId).toBeDefined();
    if (!rendered) {
      throw new Error("Expected Discord presentation components");
    }
    const built = buildDiscordComponentMessage({ spec: rendered });
    const serialized = built.components[0]?.serialize() as
      | { components?: Array<{ components?: Array<{ custom_id?: string }> }> }
      | undefined;
    expect(serialized?.components?.[0]?.components?.[0]?.custom_id).toBe(customId);
    expect(built.entries).toEqual([]);
    expect(parseExecApprovalData(parseCustomId(customId ?? "").data)).toEqual({
      approvalId: "opaque:approval;id=7",
      approvalKind: "plugin",
      action: "deny",
    });
  });

  it("renders question choices with compact option indices", () => {
    const questionId = "ask_0123456789abcdef0123456789abcdef";
    expect(
      buildDiscordPresentationComponents({
        blocks: [
          {
            type: "buttons",
            buttons: ["Staging", "Production"].map((label) => ({
              label,
              action: { type: "question" as const, questionId, optionValue: label },
            })),
          },
        ],
      }),
    ).toEqual({
      blocks: [
        {
          type: "actions",
          buttons: [
            { label: "Staging", style: "secondary", internalCustomId: `ocq:id=${questionId};i=0` },
            {
              label: "Production",
              style: "secondary",
              internalCustomId: `ocq:id=${questionId};i=1`,
            },
          ],
        },
      ],
    });
  });

  it("rejects malformed approval custom ids and compacts overlong canonical ids", () => {
    expect(
      parseExecApprovalData(parseCustomId("execapproval:kind=exec;id=%zz;action=allow-once").data),
    ).toBeNull();
    expect(
      parseExecApprovalData(
        parseCustomId("execapproval:kind=exec;id=approval-1;action=/approve").data,
      ),
    ).toBeNull();
    const overlongId = `approval/${"\u{1F4F1}".repeat(40)}`;
    const rendered = buildDiscordPresentationComponents({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Review",
              action: {
                type: "approval",
                approvalId: overlongId,
                approvalKind: "exec",
                decision: "allow-once",
              },
            },
          ],
        },
      ],
    });
    const firstBlock = rendered?.blocks?.[0];
    const customId =
      firstBlock?.type === "actions" ? firstBlock.buttons?.[0]?.internalCustomId : undefined;
    expect(customId?.length).toBeLessThanOrEqual(100);
    expect(parseExecApprovalData(parseCustomId(customId ?? "").data)).toEqual({
      approvalId: buildApprovalResolutionRef({ approvalId: overlongId, approvalKind: "exec" }),
      approvalKind: "exec",
      action: "allow-once",
    });
    expect(
      buildDiscordPresentationComponents({
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Invalid",
                action: {
                  type: "approval",
                  approvalId: "approval-1",
                  approvalKind: "invalid" as "exec",
                  decision: "allow-once",
                },
              },
            ],
          },
        ],
      }),
    ).toBeUndefined();
  });

  it("keeps legacy callbacks unchanged beside typed approvals", () => {
    expect(
      buildDiscordPresentationComponents({
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Allow",
                action: {
                  type: "approval",
                  approvalId: "approval-1",
                  approvalKind: "exec",
                  decision: "allow-once",
                },
              },
              {
                label: "Legacy",
                value: "/approve approval-1 deny",
              },
            ],
          },
        ],
      }),
    ).toEqual({
      blocks: [
        {
          type: "actions",
          buttons: [
            {
              label: "Allow",
              style: "secondary",
              internalCustomId: "execapproval:kind=exec;id=approval-1;action=allow-once",
            },
            {
              label: "Legacy",
              style: "secondary",
              callbackData: "/approve approval-1 deny",
            },
          ],
        },
      ],
    });
  });

  it("splits long shared button rows to stay within Discord action limits", () => {
    expect(
      buildDiscordInteractiveComponents({
        blocks: [
          {
            type: "buttons",
            buttons: [
              { label: "One", value: "1" },
              { label: "Two", value: "2" },
              { label: "Three", value: "3" },
              { label: "Four", value: "4" },
              { label: "Five", value: "5" },
              { label: "Six", value: "6" },
            ],
          },
        ],
      }),
    ).toEqual({
      blocks: [
        {
          type: "actions",
          buttons: [
            { label: "One", style: "secondary", callbackData: "1" },
            { label: "Two", style: "secondary", callbackData: "2" },
            { label: "Three", style: "secondary", callbackData: "3" },
            { label: "Four", style: "secondary", callbackData: "4" },
            { label: "Five", style: "secondary", callbackData: "5" },
          ],
        },
        {
          type: "actions",
          buttons: [{ label: "Six", style: "secondary", callbackData: "6" }],
        },
      ],
    });
  });

  it("does not duplicate presentation text when appending controls", () => {
    expect(
      buildDiscordPresentationComponents({
        title: "Status",
        blocks: [
          { type: "text", text: "Build completed" },
          { type: "context", text: "main branch" },
          {
            type: "buttons",
            buttons: [{ label: "Open", action: { type: "command", command: "/codex open" } }],
          },
        ],
      }),
    ).toEqual({
      blocks: [
        { type: "text", text: "Status" },
        { type: "text", text: "Build completed" },
        { type: "text", text: "-# main branch" },
        {
          type: "actions",
          buttons: [
            {
              label: "Open",
              style: "secondary",
              callbackData: "/codex open",
              callbackDataKind: "command",
            },
          ],
        },
      ],
    });
  });

  it("marks typed callback actions as opaque callback data", () => {
    expect(
      buildDiscordPresentationComponents({
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Opaque",
                action: { type: "callback", value: "/codex permissions yolo" },
              },
            ],
          },
        ],
      }),
    ).toEqual({
      blocks: [
        {
          type: "actions",
          buttons: [
            {
              label: "Opaque",
              style: "secondary",
              callbackData: "/codex permissions yolo",
              callbackDataKind: "callback",
            },
          ],
        },
      ],
    });
  });

  it("preserves disabled presentation buttons for Discord components", () => {
    expect(
      buildDiscordPresentationComponents({
        blocks: [
          {
            type: "buttons",
            buttons: [
              { label: "Already handled", value: "done", disabled: true },
              { label: "Open docs", url: "https://example.com/docs", disabled: true },
            ],
          },
        ],
      }),
    ).toEqual({
      blocks: [
        {
          type: "actions",
          buttons: [
            {
              label: "Already handled",
              style: "secondary",
              callbackData: "done",
              disabled: true,
            },
            {
              label: "Open docs",
              style: "link",
              url: "https://example.com/docs",
              disabled: true,
            },
          ],
        },
      ],
    });
  });

  it("preserves reusable presentation buttons for Discord action entries", () => {
    expect(
      buildDiscordPresentationComponents({
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Refresh", value: "refresh", reusable: true }],
          },
        ],
      }),
    ).toEqual({
      blocks: [
        {
          type: "actions",
          buttons: [
            { label: "Refresh", style: "secondary", callbackData: "refresh", reusable: true },
          ],
        },
      ],
    });
  });

  it("preserves typed command actions for command-only select options", () => {
    expect(
      buildDiscordPresentationComponents({
        blocks: [
          {
            type: "select",
            placeholder: "Pick",
            options: [
              {
                label: "Run",
                action: { type: "command", command: "/codex permissions yolo" },
                value: "/codex permissions yolo",
              },
            ],
          },
        ],
      }),
    ).toEqual({
      blocks: [
        {
          type: "actions",
          select: {
            type: "string",
            placeholder: "Pick",
            callbackDataKind: "command",
            options: [{ label: "Run", value: "/codex permissions yolo" }],
          },
        },
      ],
    });
  });

  it("marks typed callback actions for callback-only select options", () => {
    expect(
      buildDiscordPresentationComponents({
        blocks: [
          {
            type: "select",
            placeholder: "Pick",
            options: [
              {
                label: "Inspect",
                action: { type: "callback", value: "inspect:123" },
                value: "inspect:123",
              },
            ],
          },
        ],
      }),
    ).toEqual({
      blocks: [
        {
          type: "actions",
          select: {
            type: "string",
            placeholder: "Pick",
            callbackDataKind: "callback",
            options: [{ label: "Inspect", value: "inspect:123" }],
          },
        },
      ],
    });
  });

  it("does not render mixed command and callback select actions", () => {
    expect(
      buildDiscordPresentationComponents({
        blocks: [
          {
            type: "select",
            placeholder: "Pick",
            options: [
              {
                label: "Run",
                action: { type: "command", command: "/codex run" },
                value: "/codex run",
              },
              {
                label: "Inspect",
                action: { type: "callback", value: "inspect:123" },
                value: "inspect:123",
              },
            ],
          },
        ],
      }),
    ).toBeUndefined();
  });
});
