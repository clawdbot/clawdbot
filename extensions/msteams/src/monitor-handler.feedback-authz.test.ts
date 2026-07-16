import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import {
  type MSTeamsActivityHandler,
  type MSTeamsMessageHandlerDeps,
  registerMSTeamsHandlers,
} from "./monitor-handler.js";
import {
  createActivityHandler,
  createMSTeamsMessageHandlerDeps,
} from "./monitor-handler.test-helpers.js";
import { setMSTeamsRuntime } from "./runtime.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

const feedbackReflectionMockState = vi.hoisted(() => ({
  runFeedbackReflection: vi.fn(),
}));

vi.mock("./feedback-reflection.js", async () => {
  const actual = await vi.importActual<typeof import("./feedback-reflection.js")>(
    "./feedback-reflection.js",
  );
  return {
    ...actual,
    runFeedbackReflection: feedbackReflectionMockState.runFeedbackReflection,
  };
});

function createRuntimeStub(readAllowFromStore: ReturnType<typeof vi.fn>): PluginRuntime {
  return {
    logging: {
      shouldLogVerbose: () => false,
    },
    channel: {
      debounce: {
        resolveInboundDebounceMs: () => 0,
        createInboundDebouncer: () => ({
          enqueue: async () => {},
        }),
      },
      pairing: {
        readAllowFromStore,
        upsertPairingRequest: vi.fn(async () => null),
      },
      routing: {
        resolveAgentRoute: ({ peer }: { peer: { kind: string; id: string } }) => ({
          sessionKey: `msteams:${peer.kind}:${peer.id}`,
          agentId: "default",
        }),
      },
      session: {
        resolveStorePath: (storePath?: string) => storePath ?? tmpdir(),
      },
    },
  } as unknown as PluginRuntime;
}

function createDeps(params: {
  cfg: OpenClawConfig;
  readAllowFromStore?: ReturnType<typeof vi.fn>;
}): MSTeamsMessageHandlerDeps {
  const readAllowFromStore = params.readAllowFromStore ?? vi.fn(async () => []);
  setMSTeamsRuntime(createRuntimeStub(readAllowFromStore));
  return createMSTeamsMessageHandlerDeps({
    cfg: params.cfg,
    runtime: { error: vi.fn() } as unknown as RuntimeEnv,
  });
}

function createFeedbackInvokeContext(params: {
  reaction: "like" | "dislike";
  conversationId: string;
  conversationType: string;
  senderId: string;
  senderName?: string;
  teamId?: string;
  channelName?: string;
  comment?: string;
}): MSTeamsTurnContext {
  return {
    activity: {
      id: `invoke-${params.reaction}`,
      type: "invoke",
      name: "message/submitAction",
      channelId: "msteams",
      serviceUrl: "https://service.example.test",
      from: {
        id: `${params.senderId}-botframework`,
        aadObjectId: params.senderId,
        name: params.senderName ?? "Sender",
      },
      recipient: {
        id: "bot-id",
        name: "Bot",
      },
      conversation: {
        id: params.conversationId,
        conversationType: params.conversationType,
        tenantId: params.teamId ? "tenant-1" : undefined,
      },
      channelData: params.teamId
        ? {
            team: { id: params.teamId, name: "Team 1" },
            channel: params.channelName ? { name: params.channelName } : undefined,
          }
        : {},
      value: {
        actionName: "feedback",
        actionValue: {
          reaction: params.reaction,
          feedback: JSON.stringify({ feedbackText: params.comment ?? "feedback text" }),
        },
        replyToId: "bot-msg-1",
      },
    },
    sendActivity: vi.fn(async () => ({ id: "ignored" })),
    sendActivities: async () => [],
  } as unknown as MSTeamsTurnContext;
}

async function expectFileMissing(filePath: string) {
  await expect(access(filePath)).rejects.toThrow();
}

async function withFeedbackHandler(params: {
  cfg: OpenClawConfig;
  context: Parameters<typeof createFeedbackInvokeContext>[0];
  assertResult: (args: { tmpDir: string; originalRun: ReturnType<typeof vi.fn> }) => Promise<void>;
}) {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "openclaw-msteams-feedback-"));
  try {
    const originalRun = vi.fn(async () => undefined);
    const handler = registerMSTeamsHandlers(
      createActivityHandler(originalRun),
      createDeps({
        cfg: {
          ...params.cfg,
          session: { store: tmpDir },
        },
      }),
    ) as MSTeamsActivityHandler & {
      run: NonNullable<MSTeamsActivityHandler["run"]>;
    };

    await handler.run(createFeedbackInvokeContext(params.context));
    await params.assertResult({ tmpDir, originalRun });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

describe("msteams feedback invoke authz", () => {
  beforeEach(() => {
    feedbackReflectionMockState.runFeedbackReflection.mockReset();
    feedbackReflectionMockState.runFeedbackReflection.mockResolvedValue(undefined);
  });

  it("records feedback for an allowlisted DM sender", async () => {
    await withFeedbackHandler({
      cfg: {
        channels: {
          msteams: {
            dmPolicy: "allowlist",
            allowFrom: ["owner-aad"],
          },
        },
      } as OpenClawConfig,
      context: {
        reaction: "like",
        conversationId: "a:personal-chat;messageid=bot-msg-1",
        conversationType: "personal",
        senderId: "owner-aad",
        senderName: "Owner",
        comment: "allowed feedback",
      },
      assertResult: async ({ tmpDir, originalRun }) => {
        const transcript = await readFile(
          path.join(tmpDir, "msteams_direct_owner-aad.jsonl"),
          "utf-8",
        );
        expect(JSON.parse(transcript.trim())).toMatchObject({
          event: "feedback",
          messageId: "bot-msg-1",
          value: "positive",
          comment: "allowed feedback",
          sessionKey: "msteams:direct:owner-aad",
          conversationId: "a:personal-chat",
        });
        expect(originalRun).not.toHaveBeenCalled();
      },
    });
  });

  it("keeps DM feedback allowed when team route allowlists exist", async () => {
    await withFeedbackHandler({
      cfg: {
        channels: {
          msteams: {
            dmPolicy: "allowlist",
            allowFrom: ["owner-aad"],
            teams: {
              team123: {
                channels: {
                  "19:group@thread.tacv2": { requireMention: false },
                },
              },
            },
          },
        },
      } as OpenClawConfig,
      context: {
        reaction: "like",
        conversationId: "a:personal-chat;messageid=bot-msg-1",
        conversationType: "personal",
        senderId: "owner-aad",
        senderName: "Owner",
        comment: "allowed dm feedback",
      },
      assertResult: async ({ tmpDir, originalRun }) => {
        const transcript = await readFile(
          path.join(tmpDir, "msteams_direct_owner-aad.jsonl"),
          "utf-8",
        );
        expect(JSON.parse(transcript.trim())).toMatchObject({
          event: "feedback",
          value: "positive",
          comment: "allowed dm feedback",
          sessionKey: "msteams:direct:owner-aad",
        });
        expect(originalRun).not.toHaveBeenCalled();
      },
    });
  });

  it("does not record feedback for a DM sender outside allowFrom", async () => {
    await withFeedbackHandler({
      cfg: {
        channels: {
          msteams: {
            dmPolicy: "allowlist",
            allowFrom: ["owner-aad"],
          },
        },
      } as OpenClawConfig,
      context: {
        reaction: "like",
        conversationId: "a:personal-chat;messageid=bot-msg-1",
        conversationType: "personal",
        senderId: "attacker-aad",
        senderName: "Attacker",
        comment: "blocked feedback",
      },
      assertResult: async ({ tmpDir, originalRun }) => {
        await expectFileMissing(path.join(tmpDir, "msteams_direct_attacker-aad.jsonl"));
        expect(feedbackReflectionMockState.runFeedbackReflection).not.toHaveBeenCalled();
        expect(originalRun).not.toHaveBeenCalled();
      },
    });
  });

  it("does not trigger reflection for a group sender outside groupAllowFrom", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "openclaw-msteams-feedback-"));
    try {
      const originalRun = vi.fn(async () => undefined);
      const handler = registerMSTeamsHandlers(
        createActivityHandler(originalRun),
        createDeps({
          cfg: {
            session: { store: tmpDir },
            channels: {
              msteams: {
                groupPolicy: "allowlist",
                groupAllowFrom: ["owner-aad"],
                feedbackReflection: true,
              },
            },
          } as OpenClawConfig,
        }),
      ) as MSTeamsActivityHandler & {
        run: NonNullable<MSTeamsActivityHandler["run"]>;
      };

      await handler.run(
        createFeedbackInvokeContext({
          reaction: "dislike",
          conversationId: "19:group@thread.tacv2;messageid=bot-msg-1",
          conversationType: "groupChat",
          senderId: "attacker-aad",
          senderName: "Attacker",
          teamId: "team-1",
          channelName: "General",
          comment: "blocked reflection",
        }),
      );

      await expectFileMissing(path.join(tmpDir, "msteams_group_19_group_thread_tacv2.jsonl"));
      expect(feedbackReflectionMockState.runFeedbackReflection).not.toHaveBeenCalled();
      expect(originalRun).not.toHaveBeenCalled();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
