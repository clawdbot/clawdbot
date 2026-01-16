import { Type } from "@sinclair/typebox";

import { runZca, parseJsonOutput } from "./zca.js";

const ACTIONS = ["send", "image", "link", "friends", "groups", "me", "status"] as const;

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

// Tool schema - avoiding Type.Union per tool schema guardrails
export const ZalouserToolSchema = Type.Object({
  action: stringEnum(ACTIONS, { description: `Action to perform: ${ACTIONS.join(", ")}` }),
  threadId: Type.Optional(
    Type.String({ description: "Thread ID for messaging" }),
  ),
  message: Type.Optional(Type.String({ description: "Message text" })),
  isGroup: Type.Optional(Type.Boolean({ description: "Is group chat" })),
  profile: Type.Optional(Type.String({ description: "Profile name" })),
  query: Type.Optional(Type.String({ description: "Search query" })),
  url: Type.Optional(Type.String({ description: "URL for media/link" })),
}, { additionalProperties: false });

type ToolParams = {
  action: (typeof ACTIONS)[number];
  threadId?: string;
  message?: string;
  isGroup?: boolean;
  profile?: string;
  query?: string;
  url?: string;
};

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  details: unknown;
};

function json(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

export async function executeZalouserTool(
  _toolCallId: string,
  params: ToolParams,
): Promise<ToolResult> {
  try {
    switch (params.action) {
      case "send": {
        if (!params.threadId || !params.message) {
          throw new Error("threadId and message required for send action");
        }
        const args = ["msg", "send", params.threadId, params.message];
        if (params.isGroup) args.push("-g");
        const result = await runZca(args, { profile: params.profile });
        if (!result.ok) {
          throw new Error(result.stderr || "Failed to send message");
        }
        return json({ success: true, output: result.stdout });
      }

      case "image": {
        if (!params.threadId) {
          throw new Error("threadId required for image action");
        }
        if (!params.url) {
          throw new Error("url required for image action");
        }
        const args = ["msg", "image", params.threadId, "-u", params.url];
        if (params.message) args.push("-m", params.message);
        if (params.isGroup) args.push("-g");
        const result = await runZca(args, { profile: params.profile });
        if (!result.ok) {
          throw new Error(result.stderr || "Failed to send image");
        }
        return json({ success: true, output: result.stdout });
      }

      case "link": {
        if (!params.threadId || !params.url) {
          throw new Error("threadId and url required for link action");
        }
        const args = ["msg", "link", params.threadId, params.url];
        if (params.isGroup) args.push("-g");
        const result = await runZca(args, { profile: params.profile });
        if (!result.ok) {
          throw new Error(result.stderr || "Failed to send link");
        }
        return json({ success: true, output: result.stdout });
      }

      case "friends": {
        const args = params.query
          ? ["friend", "find", params.query]
          : ["friend", "list", "-j"];
        const result = await runZca(args, { profile: params.profile });
        if (!result.ok) {
          throw new Error(result.stderr || "Failed to get friends");
        }
        const parsed = parseJsonOutput(result.stdout);
        return json(parsed ?? { raw: result.stdout });
      }

      case "groups": {
        const result = await runZca(["group", "list", "-j"], {
          profile: params.profile,
        });
        if (!result.ok) {
          throw new Error(result.stderr || "Failed to get groups");
        }
        const parsed = parseJsonOutput(result.stdout);
        return json(parsed ?? { raw: result.stdout });
      }

      case "me": {
        const result = await runZca(["me", "info", "-j"], {
          profile: params.profile,
        });
        if (!result.ok) {
          throw new Error(result.stderr || "Failed to get profile");
        }
        const parsed = parseJsonOutput(result.stdout);
        return json(parsed ?? { raw: result.stdout });
      }

      case "status": {
        const result = await runZca(["auth", "status"], {
          profile: params.profile,
        });
        return json({
          authenticated: result.ok,
          output: result.stdout || result.stderr,
        });
      }

      default:
        throw new Error(
          `Unknown action: ${params.action}. Valid actions: send, image, link, friends, groups, me, status`,
        );
    }
  } catch (err) {
    return json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
