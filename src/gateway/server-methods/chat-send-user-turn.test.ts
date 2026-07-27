import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
  type GatewayClientInfo,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
import { pruneProcessedHistoryImages } from "../../agents/embedded-agent-runner/run/history-image-prune.js";
import { hydratePromptMediaMessages } from "../../agents/embedded-agent-runner/run/images.js";
import type { AgentMessage } from "../../agents/runtime/index.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import { resolveStateDir } from "../../config/paths.js";
import {
  buildPersistedUserTurnMessage,
  type UserTurnInput,
} from "../../sessions/user-turn-transcript.js";
import { applyChatSendManagedMedia, prepareChatSendUserTurn } from "./chat-send-user-turn.js";

function createUserTurnInputController() {
  const baseInput: UserTurnInput = {
    text: "raw message",
    timestamp: 1,
    idempotencyKey: "run-1:user",
  };
  let inputPromise = Promise.resolve(baseInput);
  return {
    controller: {
      baseInput,
      setInputPromise: (input: Promise<UserTurnInput>) => {
        inputPromise = input;
      },
    },
    readInput: () => inputPromise,
  };
}

function createClientInfo(overrides: Partial<GatewayClientInfo> = {}): GatewayClientInfo {
  return {
    id: GATEWAY_CLIENT_IDS.CLI,
    version: "test",
    platform: "test",
    mode: GATEWAY_CLIENT_MODES.CLI,
    ...overrides,
  };
}

function createAttachments(
  overrides: Partial<{
    explicitOriginTargetsPlugin: boolean;
    mediaPathOffloadPaths: string[];
    mediaPathOffloadTypes: string[];
    mediaPathOffloadWorkspaceDir: string | undefined;
    imageOrder: Array<"inline" | "offloaded">;
    offloadedRefs: Array<{
      mediaRef: string;
      id: string;
      path: string;
      mimeType: string;
      label: string;
      sizeBytes: number;
    }>;
    parsedMessage: string;
  }> = {},
) {
  return {
    explicitOriginTargetsPlugin: false,
    imageOrder: [],
    mediaPathOffloadPaths: [],
    mediaPathOffloadTypes: [],
    mediaPathOffloadWorkspaceDir: undefined,
    offloadedRefs: [],
    parsedImages: [],
    parsedMessage: "hello",
    prepareAttachmentsMs: undefined,
    ...overrides,
  };
}

describe("prepareChatSendUserTurn", () => {
  it("assembles command, provenance, sender, and origin facts", async () => {
    const { controller, readInput } = createUserTurnInputController();
    const prepared = prepareChatSendUserTurn({
      request: {
        clientInfo: createClientInfo({ displayName: "Gateway CLI" }),
        normalizedAttachments: [],
        suppressCommandInterpretation: false,
        systemInputProvenance: { kind: "internal_system", sourceTool: "test" },
        systemProvenanceReceipt: "[System receipt]",
        toolBindings: { browser: { kind: "tab", targetId: "target-1" } },
      },
      session: {
        agentId: "main",
        clientRunId: "run-1",
        sessionKey: "agent:main:main",
      },
      admission: {
        originatingRoute: {
          originatingChannel: "discord",
          originatingTo: "channel:1",
          accountId: "account-1",
          messageThreadId: "thread-1",
          explicitDeliverRoute: true,
        },
      },
      attachments: createAttachments({ parsedMessage: "/status" }),
      client: null,
      logGateway: { warn: vi.fn() } as never,
      userTurn: controller,
    });

    expect(prepared.ctx).toMatchObject({
      Body: "[System receipt]\n\n/status",
      BodyForAgent: "[System receipt]\n\n/status",
      BodyForCommands: "/status",
      RawBody: "/status",
      CommandSource: "text",
      CommandAuthorized: true,
      CommandTurn: {
        kind: "text-slash",
        source: "text",
        authorized: true,
        body: "/status",
      },
      InputProvenance: { kind: "internal_system", sourceTool: "test" },
      GatewayRunToolBindings: { browser: { kind: "tab", targetId: "target-1" } },
      OriginatingChannel: "discord",
      OriginatingTo: "channel:1",
      AccountId: "account-1",
      MessageThreadId: "thread-1",
      ExplicitDeliverRoute: true,
      SenderId: GATEWAY_CLIENT_IDS.CLI,
      SenderName: "Gateway CLI",
      SenderUsername: "Gateway CLI",
    });
    expect(prepared.accountId).toBe("account-1");
    expect(prepared.isInternalTextSlashCommandTurn).toBe(true);
    expect(prepared.queuedFollowupOwnerKey).toBeUndefined();
    expect(prepared.replyOptionImages).toBeUndefined();
    await expect(prepared.pluginBoundMediaPromise).resolves.toEqual([]);
    await expect(readInput()).resolves.toEqual(controller.baseInput);
  });

  it("carries pre-staged media and device ownership without UI sender decoration", async () => {
    const { controller, readInput } = createUserTurnInputController();
    const prepared = prepareChatSendUserTurn({
      request: {
        clientInfo: createClientInfo({
          id: GATEWAY_CLIENT_IDS.CONTROL_UI,
          mode: GATEWAY_CLIENT_MODES.UI,
        }),
        normalizedAttachments: [{}],
        suppressCommandInterpretation: true,
        systemInputProvenance: undefined,
        systemProvenanceReceipt: undefined,
      },
      session: {
        agentId: "main",
        clientRunId: "run-1",
        sessionKey: "agent:main:main",
      },
      admission: {
        originatingRoute: {
          originatingChannel: "webchat",
          explicitDeliverRoute: false,
        },
      },
      attachments: createAttachments({
        mediaPathOffloadPaths: ["uploads/report.pdf"],
        mediaPathOffloadTypes: ["application/pdf"],
        mediaPathOffloadWorkspaceDir: "/workspace",
      }),
      client: {
        connId: "conn-1",
        authenticatedUserProfile: {
          profileId: "profile-ada",
          displayName: "Ada",
          hasAvatar: false,
          updatedAt: 1,
        },
        connect: {
          device: { id: "device-1" },
          scopes: ["operator.admin"],
          caps: ["tool-events"],
        },
      } as never,
      logGateway: { warn: vi.fn() } as never,
      userTurn: controller,
    });

    expect(prepared.ctx).toMatchObject({
      CommandAuthorized: false,
      CommandTurn: {
        kind: "normal",
        source: "message",
        authorized: false,
        body: "hello",
      },
      ApprovalReviewerDeviceId: "device-1",
      media: [
        {
          path: "uploads/report.pdf",
          contentType: "application/pdf",
          workspaceDir: "/workspace",
        },
      ],
      GatewayClientScopes: ["operator.admin"],
      GatewayClientCaps: ["tool-events"],
      SessionCreation: {
        via: "operator",
        actor: { type: "human", id: "profile-ada" },
      },
    });
    expect(prepared.ctx).not.toHaveProperty("SenderId");
    expect(prepared.queuedFollowupOwnerKey).toBe("device:device-1");
    await expect(readInput()).resolves.toEqual(controller.baseInput);
  });

  it("carries retained image claim-check facts without changing the trailing prompt line", async () => {
    const { controller, readInput } = createUserTurnInputController();
    const mediaRef = "media://inbound/image-1.png";
    const prepared = prepareChatSendUserTurn({
      request: {
        clientInfo: createClientInfo(),
        normalizedAttachments: [{}],
        suppressCommandInterpretation: false,
        systemInputProvenance: undefined,
        systemProvenanceReceipt: undefined,
      },
      session: {
        agentId: "main",
        clientRunId: "run-1",
        sessionKey: "agent:main:main",
      },
      admission: {
        originatingRoute: {
          originatingChannel: "webchat",
          explicitDeliverRoute: false,
        },
      },
      attachments: createAttachments({
        imageOrder: ["offloaded"],
        offloadedRefs: [
          {
            mediaRef,
            id: "image-1.png",
            path: "/media/inbound/image-1.png",
            mimeType: "image/png",
            label: "image.png",
            sizeBytes: 10,
          },
        ],
        parsedMessage: `inspect\n[media attached: ${mediaRef}]`,
      }),
      client: null,
      logGateway: { warn: vi.fn() } as never,
      userTurn: controller,
    });

    expect(prepared.ctx.Body).toBe(`inspect\n[media attached: ${mediaRef}]`);
    expect(prepared.replyOptionMedia).toEqual([
      {
        path: "/media/inbound/image-1.png",
        url: mediaRef,
        contentType: "image/png",
      },
    ]);
    await expect(readInput()).resolves.toMatchObject({
      mediaImageLayout: { slots: [{ kind: "offloaded", factIndex: 0 }] },
    });
  });

  it("persists and prunes the staged PDF claim-check alias as structured ownership", async () => {
    const { controller, readInput } = createUserTurnInputController();
    const mediaRef = "media://inbound/report.pdf";
    prepareChatSendUserTurn({
      request: {
        clientInfo: createClientInfo(),
        normalizedAttachments: [{}],
        suppressCommandInterpretation: false,
        systemInputProvenance: undefined,
        systemProvenanceReceipt: undefined,
      },
      session: {
        agentId: "main",
        clientRunId: "run-1",
        sessionKey: "agent:main:main",
      },
      admission: {
        originatingRoute: { originatingChannel: "webchat", explicitDeliverRoute: false },
      },
      attachments: createAttachments({
        offloadedRefs: [
          {
            mediaRef,
            id: "report.pdf",
            path: "/media/inbound/report.pdf",
            mimeType: "application/pdf",
            label: "report.pdf",
            sizeBytes: 10,
          },
        ],
        parsedMessage: `read this\n[media attached: ${mediaRef}]`,
      }),
      client: null,
      logGateway: { warn: vi.fn() } as never,
      userTurn: controller,
    });

    const input = await readInput();
    expect(input.media).toEqual([
      {
        path: "/media/inbound/report.pdf",
        url: mediaRef,
        contentType: "application/pdf",
        hydrationSuppressed: true,
      },
    ]);
    const persisted = buildPersistedUserTurnMessage({
      ...input,
      text: `read this\n[media attached: ${mediaRef}]`,
    });
    const history = [
      persisted,
      { role: "assistant", content: "ack" },
      { role: "user", content: "more" },
      { role: "assistant", content: "ack" },
      { role: "user", content: "more" },
      { role: "assistant", content: "ack" },
      { role: "user", content: "more" },
      { role: "assistant", content: "ack" },
    ] as unknown as Parameters<typeof pruneProcessedHistoryImages>[0];
    const pruned = pruneProcessedHistoryImages(history);
    const first = pruned?.[0] as unknown as Record<string, unknown> | undefined;
    expect(first?.content).toBe(
      "read this\n[media reference removed - already processed by model]",
    );
    expect((first?.["__openclaw"] as Record<string, unknown> | undefined)?.media).toBeUndefined();
  });

  it("hydrates and prunes a staged image claim-check alias as structured ownership", async () => {
    const id = `gateway-image-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
    const imagePath = path.join(resolveStateDir(), "media", "inbound", id);
    const mediaRef = `media://inbound/${id}`;
    const unownedRef = "media://inbound/unowned.png";
    const text = `inspect\n[media attached: ${mediaRef}]\n[media attached: ${unownedRef}]`;
    await fs.mkdir(path.dirname(imagePath), { recursive: true });
    await fs.writeFile(imagePath, createSolidPngBuffer(2, 2, { r: 10, g: 20, b: 30 }));

    try {
      const { controller, readInput } = createUserTurnInputController();
      prepareChatSendUserTurn({
        request: {
          clientInfo: createClientInfo(),
          normalizedAttachments: [{}],
          suppressCommandInterpretation: false,
          systemInputProvenance: undefined,
          systemProvenanceReceipt: undefined,
        },
        session: {
          agentId: "main",
          clientRunId: "run-1",
          sessionKey: "agent:main:main",
        },
        admission: {
          originatingRoute: { originatingChannel: "webchat", explicitDeliverRoute: false },
        },
        attachments: createAttachments({
          imageOrder: ["offloaded"],
          offloadedRefs: [
            {
              mediaRef,
              id,
              path: imagePath,
              mimeType: "image/png",
              label: "image.png",
              sizeBytes: 10,
            },
          ],
          parsedMessage: text,
        }),
        client: null,
        logGateway: { warn: vi.fn() } as never,
        userTurn: controller,
      });

      const input = await readInput();
      expect(input.media).toEqual([{ path: imagePath, url: mediaRef, contentType: "image/png" }]);
      expect(input.media?.[0]).not.toHaveProperty("hydrationSuppressed");
      const persisted = buildPersistedUserTurnMessage({ ...input, text });
      expect(
        (
          (persisted as unknown as Record<string, unknown>)["__openclaw"] as {
            media?: unknown;
          }
        ).media,
      ).toEqual([{ path: imagePath, url: mediaRef, contentType: "image/png" }]);

      const hydrated = await hydratePromptMediaMessages([persisted as AgentMessage], {
        workspaceDir: path.dirname(imagePath),
        model: { input: ["text", "image"] },
        workspaceOnly: true,
      });
      expect((hydrated[0] as unknown as { content?: unknown[] }).content).toEqual([
        { type: "text", text },
        expect.objectContaining({ type: "image", mimeType: "image/png" }),
      ]);

      const history = [
        persisted,
        { role: "assistant", content: "ack" },
        { role: "user", content: "more" },
        { role: "assistant", content: "ack" },
        { role: "user", content: "more" },
        { role: "assistant", content: "ack" },
        { role: "user", content: "more" },
        { role: "assistant", content: "ack" },
      ] as unknown as Parameters<typeof pruneProcessedHistoryImages>[0];
      const pruned = pruneProcessedHistoryImages(history);
      const first = pruned?.[0] as unknown as Record<string, unknown> | undefined;
      expect(first?.content).toBe(
        `inspect\n[media reference removed - already processed by model]\n[media attached: ${unownedRef}]`,
      );
      expect((first?.["__openclaw"] as Record<string, unknown> | undefined)?.media).toBeUndefined();
    } finally {
      await fs.rm(imagePath, { force: true });
    }
  });
});

describe("applyChatSendManagedMedia", () => {
  it("does not replace pre-staged facts", () => {
    const ctx = {
      media: [{ path: "uploads/report.pdf", workspaceDir: "/workspace" }],
    } as MsgContext;

    applyChatSendManagedMedia(ctx, [{ path: "managed/image.png", contentType: "image/png" }]);

    expect(ctx.media).toEqual([{ path: "uploads/report.pdf", workspaceDir: "/workspace" }]);
  });
});
