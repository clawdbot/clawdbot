import { vi } from "vitest";
import type { OpenClawConfig, RuntimeEnv } from "../runtime-api.js";
import type { MSTeamsConversationStore } from "./conversation-store.js";
import type { MSTeamsAdapter } from "./messenger.js";
import type { MSTeamsActivityHandler, MSTeamsMessageHandlerDeps } from "./monitor-handler.js";
import type { MSTeamsPollStore } from "./polls.js";

export function createActivityHandler(
  run = vi.fn(async () => undefined),
): MSTeamsActivityHandler & {
  run: NonNullable<MSTeamsActivityHandler["run"]>;
} {
  let handler: MSTeamsActivityHandler & {
    run: NonNullable<MSTeamsActivityHandler["run"]>;
  };
  handler = {
    onMessage: () => handler,
    onMembersAdded: () => handler,
    onReactionsAdded: () => handler,
    onReactionsRemoved: () => handler,
    run,
  };
  return handler;
}

export function createMSTeamsMessageHandlerDeps(params?: {
  cfg?: OpenClawConfig;
  runtime?: RuntimeEnv;
}): MSTeamsMessageHandlerDeps {
  const adapter: MSTeamsAdapter = {
    continueConversation: async () => {},
    process: async () => {},
    updateActivity: async () => {},
    deleteActivity: async () => {},
  };
  const conversationStore: MSTeamsConversationStore = {
    upsert: async () => {},
    get: async () => null,
    list: async () => [],
    remove: async () => false,
    findPreferredDmByUserId: async () => null,
    findByUserId: async () => null,
  };
  const pollStore: MSTeamsPollStore = {
    createPoll: async () => {},
    getPoll: async () => null,
    recordVote: async () => null,
  };

  return {
    cfg: params?.cfg ?? {},
    runtime: (params?.runtime ?? { error: vi.fn() }) as RuntimeEnv,
    appId: "test-app-id",
    adapter,
    tokenProvider: {
      getAccessToken: async () => "token",
    },
    textLimit: 4000,
    mediaMaxBytes: 8 * 1024 * 1024,
    conversationStore,
    pollStore,
    log: {
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}
