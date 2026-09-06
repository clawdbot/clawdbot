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
import { normalizeCommandBody } from "../../auto-reply/commands-registry.js";
import { resolveReplyDirectiveRouting } from "../../auto-reply/reply/get-reply-directives-routing.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import { resolveSessionResetCommand } from "../../auto-reply/reply/session-reset-command.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import { resolveStateDir } from "../../config/paths.js";
import {
  listSessionParticipantsReadOnly,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { recordAcceptedSessionParticipantInput } from "../../sessions/session-participant-input-recording.js";
import { prepareChannelParticipantObservation } from "../../sessions/session-participant-input.js";
import {
  buildPersistedUserTurnMessage,
  type UserTurnInput,
} from "../../sessions/user-turn-transcript.js";
import { ensureGatewayOwnerProfile, ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as chatAttachments from "../chat-attachments.js";
import { applyChatSendManagedMedia, prepareChatSendUserTurn } from "./chat-send-user-turn.js";

function createUserTurnInputController(text = "raw message") {
  const baseInput: UserTurnInput = {
    text,
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
    parsedImages: Array<{
      type: "image";
      data: string;
      mimeType: string;
      sourceIndex: number;
    }>;
    offloadedRefs: Array<{
      mediaRef: string;
      id: string;
      path: string;
      sourceIndex: number;
      kind: "image" | "audio" | "video" | "document" | "sticker" | "unknown";
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
  it.each(["profile", "synthetic", "profileless", "profileless-ui", "system"] as const)(
    "records only accepted authenticated external input after retargeting: %s",
    async (kind) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const profile = ensureProfileForEmail("accepted@example.test", { env: state.env });
        const { controller } = createUserTurnInputController();
        const clientInfo = createClientInfo(
          kind === "profileless-ui"
            ? { id: GATEWAY_CLIENT_IDS.CONTROL_UI, mode: GATEWAY_CLIENT_MODES.WEBCHAT }
            : {},
        );
        const prepared = prepareChatSendUserTurn({
          request: {
            inboundMessage: "hello",
            clientInfo,
            suppressCommandInterpretation: false,
            systemInputProvenance:
              kind === "system" ? { kind: "internal_system", sourceTool: "fixture" } : undefined,
            systemProvenanceReceipt: undefined,
          },
          session: { agentId: "main", clientRunId: "accepted", sessionKey: "agent:main:original" },
          admission: {
            originatingRoute: { originatingChannel: "webchat", explicitDeliverRoute: false },
          },
          attachments: createAttachments(),
          client: {
            ...(!kind.startsWith("profileless")
              ? {
                  authenticatedUserProfile: {
                    profileId: profile.id,
                    displayName: profile.displayName,
                    hasAvatar: false,
                    updatedAt: profile.updatedAt,
                  },
                }
              : {}),
            internal: kind === "synthetic" ? { syntheticClient: true } : undefined,
            connect: {
              minProtocol: 1,
              maxProtocol: 1,
              client: clientInfo,
              scopes: ["operator.write"],
            },
          },
          logGateway: createSubsystemLogger("test/participant"),
          userTurn: controller,
        });
        const scope = { agentId: "main", env: state.env, sessionKey: "agent:main:retargeted" };
        await upsertSessionEntryCore(scope, { sessionId: "retargeted", updatedAt: 2 });
        const target = {
          agentId: "main",
          sessionKey: scope.sessionKey,
          storePath: state.statePath("agents", "main", "agent", "openclaw-agent.sqlite"),
        };
        prepareChannelParticipantObservation(prepared.ctx);
        recordAcceptedSessionParticipantInput({ ...prepared.ctx }, target);
        recordAcceptedSessionParticipantInput(prepared.ctx, target);
        await new Promise<void>((resolve) => {
          queueMicrotask(resolve);
        });
        expect(listSessionParticipantsReadOnly(scope).get(scope.sessionKey)).toEqual(
          kind === "profile"
            ? [
                {
                  identity: { type: "profile", id: profile.id },
                  contributionCount: 1,
                  firstPromptedAt: 1,
                  lastPromptedAt: 1,
                },
              ]
            : kind === "profileless"
              ? [
                  {
                    identity: {
                      type: "observation",
                      pluginId: null,
                      accountId: null,
                      senderKind: "unknown",
                      id: clientInfo.id,
                    },
                    contributionCount: 1,
                    firstPromptedAt: 1,
                    lastPromptedAt: 1,
                  },
                ]
              : undefined,
        );
        expect(
          listSessionParticipantsReadOnly({ ...scope, sessionKey: "agent:main:original" }).size,
        ).toBe(0);
      });
    },
  );

  it.each([false, true])(
    "preserves sandbox policy for attributed chat (system actor: %s)",
    async (systemActor) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const profile = systemActor
          ? ensureGatewayOwnerProfile("Gateway Owner")
          : ensureProfileForEmail("chat-sandbox-creator@example.com");
        const { controller } = createUserTurnInputController();
        const prepared = prepareChatSendUserTurn({
          request: {
            inboundMessage: "hello",
            clientInfo: createClientInfo(),
            suppressCommandInterpretation: false,
            systemInputProvenance: undefined,
            systemProvenanceReceipt: undefined,
          },
          session: {
            agentId: "main",
            clientRunId: "run-1",
            sessionKey: "agent:main:dashboard:guest-chat",
            cfg: {
              gateway: {
                roles: {
                  default: "guest",
                  definitions: {
                    guest: {
                      sessions: { others: "view" },
                      agents: "*",
                      scopes: ["operator.write"],
                      sandbox: "required",
                    },
                  },
                },
              },
            },
          },
          admission: {
            originatingRoute: { originatingChannel: "webchat", explicitDeliverRoute: false },
          },
          attachments: createAttachments(),
          client: {
            ...(systemActor ? { internal: { operatorRoleActor: { kind: "system" } } } : {}),
            authenticatedUserProfile: {
              profileId: profile.id,
              displayName: profile.displayName,
              hasAvatar: false,
              updatedAt: profile.updatedAt,
            },
            connect: { scopes: ["operator.write"] },
          } as never,
          logGateway: { warn: vi.fn() } as never,
          userTurn: controller,
        });

        expect(prepared.ctx.SessionCreation).toEqual({
          via: "operator",
          actor: { type: "human", source: "profile", id: profile.id },
          ...(systemActor ? {} : { sandbox: "required" }),
          skillLibrarySelections: [],
        });
      });
    },
  );

  it.each([
    { name: "status", inboundMessage: "/status", suppressed: false },
    {
      name: "multiline skill",
      inboundMessage: "/skill weather\n  first\n  second",
      suppressed: false,
    },
    { name: "reset", inboundMessage: "/reset\ninspect this", suppressed: false },
    { name: "suppressed status", inboundMessage: "/status", suppressed: true },
  ])(
    "separates $name command input from attachment text while preserving turn facts",
    async ({ inboundMessage, suppressed }) => {
      const { controller, readInput } = createUserTurnInputController(inboundMessage);
      const parsedMessage = `${inboundMessage}\n[media attached: media://inbound/voice.mp3]`;
      const prepared = prepareChatSendUserTurn({
        request: {
          inboundMessage,
          clientInfo: createClientInfo({ displayName: "Gateway CLI" }),
          suppressCommandInterpretation: suppressed,
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
        attachments: createAttachments({
          parsedMessage,
          mediaPathOffloadPaths: ["/workspace/voice.mp3"],
          mediaPathOffloadTypes: ["audio/mpeg"],
          mediaPathOffloadWorkspaceDir: "/workspace",
        }),
        client: null,
        logGateway: { warn: vi.fn() } as never,
        userTurn: controller,
      });

      expect(prepared.ctx).toMatchObject({
        Body: `[System receipt]\n\n${parsedMessage}`,
        BodyForAgent: `[System receipt]\n\n${parsedMessage}`,
        BodyForCommands: inboundMessage,
        CommandBody: inboundMessage,
        RawBody: parsedMessage,
        CommandAuthorized: !suppressed,
        CommandTurn: {
          kind: suppressed ? "normal" : "text-slash",
          source: suppressed ? "message" : "text",
          authorized: !suppressed,
          body: inboundMessage,
        },
        media: [
          { path: "/workspace/voice.mp3", contentType: "audio/mpeg", workspaceDir: "/workspace" },
        ],
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
      expect(prepared.isInternalTextSlashCommandTurn).toBe(!suppressed);
      expect(prepared.ctx.CommandSource).toBe(suppressed ? undefined : "text");
      expect(prepared.ctx.CommandInterpretationSuppressed).toBe(suppressed ? true : undefined);
      const ctx = finalizeInboundContext(prepared.ctx);
      const routed = resolveReplyDirectiveRouting({
        commandText: ctx.commandText,
        agentText: ctx.agentText,
        modelAliases: [],
        canInterpretTextDirectives: !suppressed,
        isAuthorizedSender: !suppressed,
        isGroup: false,
        wasMentioned: false,
        ctx,
        cfg: {},
        agentId: "main",
        resetTriggered: false,
      });
      expect(routed.hasInlineStatus).toBe(false);
      if (inboundMessage.startsWith("/skill")) {
        expect(normalizeCommandBody(ctx.commandText)).toBe("/skill weather\nfirst\n  second");
      }
      if (inboundMessage.startsWith("/reset")) {
        expect(
          resolveSessionResetCommand({
            commandText: ctx.commandText,
            rawText: ctx.rawText,
            resetTriggers: ["/reset"],
            ctx,
            cfg: {},
            agentId: "main",
            isGroup: false,
            resetAuthorized: true,
          }).payload,
        ).toBe("inspect this\n[media attached: media://inbound/voice.mp3]");
      }
      expect(prepared.queuedFollowupOwnerKey).toBeUndefined();
      expect(prepared.replyOptionImages).toBeUndefined();
      await expect(prepared.pluginBoundMediaPromise).resolves.toEqual([]);
      await expect(readInput()).resolves.toEqual(controller.baseInput);
    },
  );

  it("carries pre-staged media and device ownership without UI sender decoration", async () => {
    const { controller, readInput } = createUserTurnInputController();
    const prepared = prepareChatSendUserTurn({
      request: {
        inboundMessage: "hello",
        clientInfo: createClientInfo({
          id: GATEWAY_CLIENT_IDS.CONTROL_UI,
          mode: GATEWAY_CLIENT_MODES.UI,
        }),
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
      CommandInterpretationSuppressed: true,
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
        inboundMessage: "inspect",
        clientInfo: createClientInfo(),
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
            kind: "image",
            mimeType: "image/png",
            label: "image.png",
            sizeBytes: 10,
            sourceIndex: 0,
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

  it("persists video then image as claim-only facts with the image at fact index one", async () => {
    const { controller, readInput } = createUserTurnInputController();
    prepareChatSendUserTurn({
      request: {
        inboundMessage: "hello",
        clientInfo: createClientInfo(),
        suppressCommandInterpretation: false,
        systemInputProvenance: undefined,
        systemProvenanceReceipt: undefined,
      },
      session: {
        agentId: "main",
        clientRunId: "run-mixed",
        sessionKey: "agent:main:main",
      },
      admission: {
        originatingRoute: { originatingChannel: "webchat", explicitDeliverRoute: false },
      },
      attachments: createAttachments({
        imageOrder: ["offloaded"],
        offloadedRefs: [
          {
            mediaRef: "https://signed.example/video",
            id: "video.mp4",
            path: "/private/media/video.mp4",
            sourceIndex: 0,
            kind: "video",
            mimeType: "video/mp4",
            label: "video.mp4",
            sizeBytes: 20,
          },
          {
            mediaRef: "file:///private/image.png",
            id: "image.png",
            path: "/private/media/image.png",
            sourceIndex: 1,
            kind: "image",
            mimeType: "image/png",
            label: "image.png",
            sizeBytes: 10,
          },
        ],
      }),
      client: null,
      logGateway: { warn: vi.fn() } as never,
      userTurn: controller,
    });

    const input = await readInput();
    expect(input.media?.map((fact) => fact.kind)).toEqual(["video", "image"]);
    expect(input.mediaImageLayout).toEqual({
      slots: [{ kind: "offloaded", factIndex: 1 }],
    });
    const serialized = JSON.stringify(buildPersistedUserTurnMessage(input));
    expect(serialized).toContain("media://inbound/video.mp4");
    expect(serialized).toContain("media://inbound/image.png");
    for (const privateValue of [
      "/private/media",
      "signed.example",
      "file://",
      "workspaceDir",
      '"data"',
      "base64",
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it("records a visible durable omission without failing the live inline-image turn", async () => {
    const persist = vi
      .spyOn(chatAttachments, "persistInboundImagesForTranscript")
      .mockResolvedValueOnce({ entries: [], omission: "inline-image-save-failed" });
    try {
      const { controller, readInput } = createUserTurnInputController();
      const prepared = prepareChatSendUserTurn({
        request: {
          inboundMessage: "hello",
          clientInfo: createClientInfo(),
          suppressCommandInterpretation: false,
          systemInputProvenance: undefined,
          systemProvenanceReceipt: undefined,
        },
        session: {
          agentId: "main",
          clientRunId: "run-omission",
          sessionKey: "agent:main:main",
        },
        admission: {
          originatingRoute: { originatingChannel: "webchat", explicitDeliverRoute: false },
        },
        attachments: createAttachments({
          imageOrder: ["inline"],
          parsedImages: [
            { type: "image", data: "aGVsbG8=", mimeType: "image/jpeg", sourceIndex: 0 },
          ],
        }),
        client: null,
        logGateway: { warn: vi.fn() } as never,
        userTurn: controller,
      });

      expect(prepared.replyOptionImages).toEqual([
        { type: "image", data: "aGVsbG8=", mimeType: "image/jpeg", sourceIndex: 0 },
      ]);
      await expect(readInput()).resolves.toMatchObject({
        text: "raw message\n[image attachment omitted: durable managed media claim unavailable]",
      });
    } finally {
      persist.mockRestore();
    }
  });

  it.each([
    { kind: "audio" as const, mimeType: "audio/mpeg", fileName: "voice.mp3" },
    { kind: "video" as const, mimeType: "video/mp4", fileName: "clip.mp4" },
  ])("persists structured inbound $kind history facts", async ({ kind, mimeType, fileName }) => {
    const { controller, readInput } = createUserTurnInputController();
    const mediaRef = `media://inbound/${fileName}`;
    prepareChatSendUserTurn({
      request: {
        inboundMessage: "play this",
        clientInfo: createClientInfo(),
        suppressCommandInterpretation: false,
        systemInputProvenance: undefined,
        systemProvenanceReceipt: undefined,
      },
      session: {
        agentId: "main",
        clientRunId: `run-${kind}`,
        sessionKey: "agent:main:main",
      },
      admission: {
        originatingRoute: { originatingChannel: "webchat", explicitDeliverRoute: false },
      },
      attachments: createAttachments({
        offloadedRefs: [
          {
            mediaRef,
            id: fileName,
            path: `/media/inbound/${fileName}`,
            kind,
            mimeType,
            label: fileName,
            sizeBytes: 12,
            sourceIndex: 0,
          },
        ],
        parsedMessage: `play this\n[media attached: ${mediaRef}]`,
      }),
      client: null,
      logGateway: { warn: vi.fn() } as never,
      userTurn: controller,
    });

    const input = await readInput();
    expect(input.media).toEqual([
      {
        url: mediaRef,
        contentType: mimeType,
        kind,
        fileName,
        sizeBytes: 12,
        hydrationSuppressed: true,
      },
    ]);
    const persisted = buildPersistedUserTurnMessage({ ...input, text: "play this" });
    expect(
      ((persisted as unknown as Record<string, unknown>)["__openclaw"] as { media?: unknown })
        .media,
    ).toEqual(input.media);
  });

  it("persists and prunes the managed PDF claim as structured ownership", async () => {
    const { controller, readInput } = createUserTurnInputController();
    const mediaRef = "media://inbound/report.pdf";
    prepareChatSendUserTurn({
      request: {
        inboundMessage: "read this",
        clientInfo: createClientInfo(),
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
            kind: "document",
            mimeType: "application/pdf",
            label: "report.pdf",
            sizeBytes: 10,
            sourceIndex: 0,
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
        url: mediaRef,
        contentType: "application/pdf",
        kind: "document",
        fileName: "report.pdf",
        sizeBytes: 10,
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
          inboundMessage: "inspect",
          clientInfo: createClientInfo(),
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
              kind: "image",
              mimeType: "image/png",
              label: "image.png",
              sizeBytes: 10,
              sourceIndex: 0,
            },
          ],
          parsedMessage: text,
        }),
        client: null,
        logGateway: { warn: vi.fn() } as never,
        userTurn: controller,
      });

      const input = await readInput();
      expect(input.media).toEqual([
        {
          url: mediaRef,
          contentType: "image/png",
          kind: "image",
          fileName: "image.png",
          sizeBytes: 10,
        },
      ]);
      expect(input.media?.[0]).not.toHaveProperty("hydrationSuppressed");
      const persisted = buildPersistedUserTurnMessage({ ...input, text });
      expect(
        (
          (persisted as unknown as Record<string, unknown>)["__openclaw"] as {
            media?: unknown;
          }
        ).media,
      ).toEqual([
        {
          url: mediaRef,
          contentType: "image/png",
          kind: "image",
          fileName: "image.png",
          sizeBytes: 10,
        },
      ]);

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
