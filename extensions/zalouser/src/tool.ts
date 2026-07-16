import { Type } from "@sinclair/typebox";
import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { sendImageZalouser, sendLinkZalouser, sendMessageZalouser } from "./send.js";
import { parseZalouserOutboundTarget } from "./session-route.js";
import {
  checkZaloAuthenticated,
  getZaloUserInfo,
  listZaloFriendsMatching,
  listZaloGroupsMatching,
} from "./zalo-js.js";

const ACTIONS = ["send", "image", "link", "friends", "groups", "me", "status"] as const;

type AgentToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
};

function stringEnum<T extends readonly string[]>(
  values: T,
  options: { description?: string } = {},
) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    ...options,
  });
}

export const ZalouserToolSchema = Type.Object(
  {
    action: stringEnum(ACTIONS, { description: `Action to perform: ${ACTIONS.join(", ")}` }),
    threadId: Type.Optional(Type.String({ description: "Thread ID for messaging" })),
    message: Type.Optional(Type.String({ description: "Message text" })),
    isGroup: Type.Optional(Type.Boolean({ description: "Is group chat" })),
    profile: Type.Optional(Type.String({ description: "Profile name" })),
    query: Type.Optional(Type.String({ description: "Search query" })),
    url: Type.Optional(Type.String({ description: "URL for media/link" })),
  },
  { additionalProperties: false },
);

type ToolParams = {
  action: (typeof ACTIONS)[number];
  threadId?: string;
  message?: string;
  isGroup?: boolean;
  profile?: string;
  query?: string;
  url?: string;
};

type ZalouserToolContext = Pick<OpenClawPluginToolContext, "deliveryContext">;

function json(payload: unknown): AgentToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function resolveAmbientZalouserTarget(context?: ZalouserToolContext): {
  threadId?: string;
  isGroup?: boolean;
} {
  const deliveryContext = context?.deliveryContext;
  const rawTarget = deliveryContext?.to;
  if (
    (deliveryContext?.channel === undefined || deliveryContext.channel === "zalouser") &&
    typeof rawTarget === "string" &&
    rawTarget.trim()
  ) {
    try {
      return parseZalouserOutboundTarget(rawTarget);
    } catch {
      // Ignore unrelated delivery targets; explicit tool params still win.
    }
  }
  if (deliveryContext?.channel && deliveryContext.channel !== "zalouser") {
    return {};
  }
  const ambientThreadId = deliveryContext?.threadId;
  if (typeof ambientThreadId === "string" && ambientThreadId.trim()) {
    return { threadId: ambientThreadId.trim() };
  }
  if (typeof ambientThreadId === "number" && Number.isFinite(ambientThreadId)) {
    return { threadId: String(ambientThreadId) };
  }
  return {};
}

function resolveZalouserSendTarget(params: ToolParams, context?: ZalouserToolContext) {
  const explicitThreadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
  const ambientTarget = resolveAmbientZalouserTarget(context);
  return {
    threadId: explicitThreadId || ambientTarget.threadId,
    isGroup: typeof params.isGroup === "boolean" ? params.isGroup : ambientTarget.isGroup,
  };
}

export async function executeZalouserTool(
  _toolCallId: string,
  params: ToolParams,
  _signal?: AbortSignal,
  _onUpdate?: unknown,
  context?: ZalouserToolContext,
): Promise<AgentToolResult> {
  try {
    switch (params.action) {
      case "send": {
        const target = resolveZalouserSendTarget(params, context);
        if (!target.threadId || !params.message) {
          throw new Error("threadId and message required for send action");
        }
        const result = await sendMessageZalouser(target.threadId, params.message, {
          profile: params.profile,
          isGroup: target.isGroup,
        });
        if (!result.ok) {
          throw new Error(result.error || "Failed to send message");
        }
        return json({ success: true, messageId: result.messageId });
      }

      case "image": {
        const target = resolveZalouserSendTarget(params, context);
        if (!target.threadId) {
          throw new Error("threadId required for image action");
        }
        if (!params.url) {
          throw new Error("url required for image action");
        }
        const result = await sendImageZalouser(target.threadId, params.url, {
          profile: params.profile,
          caption: params.message,
          isGroup: target.isGroup,
        });
        if (!result.ok) {
          throw new Error(result.error || "Failed to send image");
        }
        return json({ success: true, messageId: result.messageId });
      }

      case "link": {
        const target = resolveZalouserSendTarget(params, context);
        if (!target.threadId || !params.url) {
          throw new Error("threadId and url required for link action");
        }
        const result = await sendLinkZalouser(target.threadId, params.url, {
          profile: params.profile,
          caption: params.message,
          isGroup: target.isGroup,
        });
        if (!result.ok) {
          throw new Error(result.error || "Failed to send link");
        }
        return json({ success: true, messageId: result.messageId });
      }

      case "friends": {
        const rows = await listZaloFriendsMatching(params.profile, params.query);
        return json(rows);
      }

      case "groups": {
        const rows = await listZaloGroupsMatching(params.profile, params.query);
        return json(rows);
      }

      case "me": {
        const info = await getZaloUserInfo(params.profile);
        return json(info ?? { error: "Not authenticated" });
      }

      case "status": {
        const authenticated = await checkZaloAuthenticated(params.profile);
        return json({
          authenticated,
          output: authenticated ? "authenticated" : "not authenticated",
        });
      }

      default: {
        params.action satisfies never;
        throw new Error(
          `Unknown action: ${String(params.action)}. Valid actions: send, image, link, friends, groups, me, status`,
        );
      }
    }
  } catch (err) {
    return json({
      error: formatErrorMessage(err),
    });
  }
}

export function createZalouserTool(context?: ZalouserToolContext): AnyAgentTool {
  return {
    name: "zalouser",
    label: "Zalo Personal",
    description:
      "Send messages and access data via Zalo personal account. " +
      "Actions: send (text message), image (send image URL), link (send link), " +
      "friends (list/search friends), groups (list groups), me (profile info), status (auth check).",
    parameters: ZalouserToolSchema,
    execute: async (toolCallId, params, signal, onUpdate) =>
      await executeZalouserTool(toolCallId, params as ToolParams, signal, onUpdate, context),
  } satisfies AnyAgentTool;
}
