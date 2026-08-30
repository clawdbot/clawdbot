import { vi } from "vitest";
import type { OpenClawConfig } from "../../runtime-api.js";
import type { GraphThreadMessage } from "../graph-thread.js";
import type { createMSTeamsMessageHandler } from "./message-handler.js";

type HandlerInput = Parameters<ReturnType<typeof createMSTeamsMessageHandler>>[0];
type TestThreadUser = {
  id?: string;
  displayName: string;
};
type TestAttachment = {
  contentType: string;
  content: string;
};

export function createThreadMessage(params: {
  id: string;
  user: TestThreadUser;
  content: string;
}): GraphThreadMessage {
  return {
    id: params.id,
    from: { user: params.user },
    body: {
      content: params.content,
      contentType: "text",
    },
  };
}

export function createThreadAllowlistConfig(params: {
  groupAllowFrom: string[];
  dangerouslyAllowNameMatching?: boolean;
}): OpenClawConfig {
  return {
    channels: {
      msteams: {
        groupPolicy: "allowlist",
        groupAllowFrom: params.groupAllowFrom,
        contextVisibility: "allowlist",
        requireMention: false,
        ...(params.dangerouslyAllowNameMatching ? { dangerouslyAllowNameMatching: true } : {}),
        teams: {
          team123: {
            channels: {
              "19:channel@thread.tacv2": { requireMention: false },
            },
          },
        },
      },
    },
  } as OpenClawConfig;
}

export function createMessageActivity(params: {
  id: string;
  text: string;
  conversation: {
    id: string;
    conversationType: "personal" | "groupChat" | "channel";
    tenantId?: string;
  };
  from: {
    id: string;
    aadObjectId: string;
    name: string;
  };
  channelData?: Record<string, unknown>;
  attachments?: TestAttachment[];
  extraActivity?: Record<string, unknown>;
}): HandlerInput {
  return {
    activity: {
      id: params.id,
      type: "message",
      text: params.text,
      from: params.from,
      recipient: {
        id: "bot-id",
        name: "Bot",
      },
      conversation: params.conversation,
      channelData: params.channelData ?? {},
      attachments: params.attachments ?? [],
      ...params.extraActivity,
    },
    sendActivity: vi.fn(async () => undefined),
  } as unknown as HandlerInput;
}

export function createAttackerGroupActivity(params?: {
  text?: string;
  channelData?: Record<string, unknown>;
  conversationId?: string;
}): HandlerInput {
  return createMessageActivity({
    id: "msg-1",
    text: params?.text ?? "hello",
    from: {
      id: "attacker-id",
      aadObjectId: "attacker-aad",
      name: "Attacker",
    },
    conversation: {
      id: params?.conversationId ?? "19:group@thread.tacv2",
      conversationType: "groupChat",
    },
    channelData: params?.channelData,
  });
}

export function createAttackerPersonalActivity(id: string): HandlerInput {
  return createMessageActivity({
    id,
    text: "hello",
    from: {
      id: "attacker-id",
      aadObjectId: "attacker-aad",
      name: "Attacker",
    },
    conversation: {
      id: "a:personal-chat",
      conversationType: "personal",
    },
  });
}

export function createChannelThreadActivity(params?: {
  attachments?: TestAttachment[];
  parentMessageId?: string;
}): HandlerInput {
  return createMessageActivity({
    id: "current-msg",
    text: "Current message",
    from: {
      id: "alice-botframework-id",
      aadObjectId: "alice-aad",
      name: "Alice",
    },
    conversation: {
      id: "19:channel@thread.tacv2",
      conversationType: "channel",
    },
    channelData: {
      team: { id: "team123", name: "Team 123", aadGroupId: "graph-team-123" },
      channel: { id: "19:graph-channel@thread.tacv2", name: "General" },
    },
    extraActivity: { replyToId: params?.parentMessageId ?? "parent-msg" },
    attachments: params?.attachments ?? [],
  });
}

export function createQuoteAttachment(): TestAttachment {
  return {
    contentType: "text/html",
    content:
      '<blockquote itemtype="http://schema.skype.com/Reply"><strong itemprop="mri">Alice</strong><p itemprop="copy">Quoted body</p></blockquote>',
  };
}
