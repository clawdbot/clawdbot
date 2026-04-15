import { Type } from "@sinclair/typebox";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { extractToolSend } from "openclaw/plugin-sdk/tool-send";
import { requiresExplicitMatrixDefaultAccount } from "./account-selection.js";
import { resolveDefaultMatrixAccountId, resolveMatrixAccount } from "./matrix/accounts.js";
import {
  createActionGate,
  readNumberParam,
  readStringParam,
  ToolAuthorizationError,
  type ChannelMessageActionAdapter,
  type ChannelMessageActionContext,
  type ChannelMessageActionName,
  type ChannelMessageToolDiscovery,
} from "./runtime-api.js";
import type { CoreConfig } from "./types.js";

const MATRIX_PLUGIN_HANDLED_ACTIONS = new Set<ChannelMessageActionName>([
  "send",
  "poll-vote",
  "react",
  "reactions",
  "read",
  "edit",
  "delete",
  "pin",
  "unpin",
  "list-pins",
  "set-profile",
  "member-info",
  "channel-info",
  "permissions",
]);
const MATRIX_PROFILE_MEDIA_PROPERTIES = {
  avatarUrl: Type.Optional(
    Type.String({
      description:
        "Profile avatar URL for Matrix self-profile update actions. Matrix accepts mxc:// and http(s) URLs.",
    }),
  ),
  avatar_url: Type.Optional(
    Type.String({
      description:
        "snake_case alias of avatarUrl for Matrix self-profile update actions. Matrix accepts mxc:// and http(s) URLs.",
    }),
  ),
  avatarPath: Type.Optional(
    Type.String({
      description:
        "Local avatar file path for Matrix self-profile update actions. Matrix uploads this file and sets the resulting MXC URI.",
    }),
  ),
  avatar_path: Type.Optional(
    Type.String({
      description:
        "snake_case alias of avatarPath for Matrix self-profile update actions. Matrix uploads this file and sets the resulting MXC URI.",
    }),
  ),
} as const;
const MATRIX_PROFILE_MEDIA_SOURCE_PARAMS = Object.freeze(["avatarUrl", "avatarPath"]);

function createMatrixExposedActions(params: {
  gate: ReturnType<typeof createActionGate>;
  encryptionEnabled: boolean;
  senderIsOwner?: boolean;
}) {
  const actions = new Set<ChannelMessageActionName>(["poll", "poll-vote"]);
  if (params.gate("messages")) {
    actions.add("send");
    actions.add("read");
    actions.add("edit");
    actions.add("delete");
  }
  if (params.gate("reactions")) {
    actions.add("react");
    actions.add("reactions");
  }
  if (params.gate("pins")) {
    actions.add("pin");
    actions.add("unpin");
    actions.add("list-pins");
  }
  if (params.gate("profile") && params.senderIsOwner === true) {
    actions.add("set-profile");
  }
  if (params.gate("memberInfo")) {
    actions.add("member-info");
  }
  if (params.gate("channelInfo")) {
    actions.add("channel-info");
  }
  if (params.encryptionEnabled && params.gate("verification")) {
    actions.add("permissions");
  }
  return actions;
}

function buildMatrixProfileToolSchema(): NonNullable<ChannelMessageToolDiscovery["schema"]> {
  return {
    properties: {
      displayName: Type.Optional(
        Type.String({
          description: "Profile display name for Matrix self-profile update actions.",
        }),
      ),
      display_name: Type.Optional(
        Type.String({
          description: "snake_case alias of displayName for Matrix self-profile update actions.",
        }),
      ),
      ...MATRIX_PROFILE_MEDIA_PROPERTIES,
    },
  };
}

export const matrixMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: ({ cfg, accountId, senderIsOwner }) => {
    const resolvedCfg = cfg as CoreConfig;
    if (!accountId && requiresExplicitMatrixDefaultAccount(resolvedCfg)) {
      return { actions: [], capabilities: [] };
    }
    const account = resolveMatrixAccount({
      cfg: resolvedCfg,
      accountId: accountId ?? resolveDefaultMatrixAccountId(resolvedCfg),
    });
    if (!account.enabled || !account.configured) {
      return { actions: [], capabilities: [] };
    }
    const gate = createActionGate(account.config.actions);
    const actions = createMatrixExposedActions({
      gate,
      encryptionEnabled: account.config.encryption === true,
      senderIsOwner,
    });
    const listedActions = Array.from(actions);
    return {
      actions: listedActions,
      capabilities: [],
      schema: listedActions.includes("set-profile") ? buildMatrixProfileToolSchema() : null,
      mediaSourceParams: listedActions.includes("set-profile")
        ? { "set-profile": MATRIX_PROFILE_MEDIA_SOURCE_PARAMS }
        : null,
    };
  },
  supportsAction: ({ action }) => MATRIX_PLUGIN_HANDLED_ACTIONS.has(action),
  extractToolSend: ({ args }) => {
    return extractToolSend(args, "sendMessage");
  },
  handleAction: async (ctx: ChannelMessageActionContext) => {
    const { handleMatrixAction } = await import("./tool-actions.runtime.js");
    const { action, params, cfg, accountId, mediaLocalRoots } = ctx;
    const dispatch = async (actionParams: Record<string, unknown>) =>
      await handleMatrixAction(
        {
          ...actionParams,
          ...(accountId ? { accountId } : {}),
        },
        cfg as CoreConfig,
        { mediaLocalRoots },
      );
    const resolveRoomId = () =>
      readStringParam(params, "roomId") ??
      readStringParam(params, "channelId") ??
      readStringParam(params, "to", { required: true });

    if (action === "send") {
      const to = readStringParam(params, "to", { required: true });
      const mediaUrl =
        readStringParam(params, "media", { trim: false }) ??
        readStringParam(params, "mediaUrl", { trim: false }) ??
        readStringParam(params, "filePath", { trim: false }) ??
        readStringParam(params, "path", { trim: false });
      const content = readStringParam(params, "message", {
        required: !mediaUrl,
        allowEmpty: true,
      });
      const replyTo = readStringParam(params, "replyTo");
      const threadId = readStringParam(params, "threadId");
      const audioAsVoice =
        typeof params.asVoice === "boolean"
          ? params.asVoice
          : typeof params.audioAsVoice === "boolean"
            ? params.audioAsVoice
            : undefined;
      return await dispatch({
        action: "sendMessage",
        to,
        content,
        mediaUrl: mediaUrl ?? undefined,
        replyToId: replyTo ?? undefined,
        threadId: threadId ?? undefined,
        audioAsVoice,
      });
    }

    if (action === "poll-vote") {
      return await dispatch({
        ...params,
        action: "pollVote",
      });
    }

    if (action === "react") {
      const messageId = readStringParam(params, "messageId", { required: true });
      const emoji = readStringParam(params, "emoji", { allowEmpty: true });
      const remove = typeof params.remove === "boolean" ? params.remove : undefined;
      return await dispatch({
        action: "react",
        roomId: resolveRoomId(),
        messageId,
        emoji,
        remove,
      });
    }

    if (action === "reactions") {
      const messageId = readStringParam(params, "messageId", { required: true });
      const limit = readNumberParam(params, "limit", { integer: true });
      return await dispatch({
        action: "reactions",
        roomId: resolveRoomId(),
        messageId,
        limit,
      });
    }

    if (action === "read") {
      const limit = readNumberParam(params, "limit", { integer: true });
      return await dispatch({
        action: "readMessages",
        roomId: resolveRoomId(),
        limit,
        before: readStringParam(params, "before"),
        after: readStringParam(params, "after"),
      });
    }

    if (action === "edit") {
      const messageId = readStringParam(params, "messageId", { required: true });
      const content = readStringParam(params, "message", { required: true });
      return await dispatch({
        action: "editMessage",
        roomId: resolveRoomId(),
        messageId,
        content,
      });
    }

    if (action === "delete") {
      const messageId = readStringParam(params, "messageId", { required: true });
      return await dispatch({
        action: "deleteMessage",
        roomId: resolveRoomId(),
        messageId,
      });
    }

    if (action === "pin" || action === "unpin" || action === "list-pins") {
      const messageId =
        action === "list-pins"
          ? undefined
          : readStringParam(params, "messageId", { required: true });
      return await dispatch({
        action: action === "pin" ? "pinMessage" : action === "unpin" ? "unpinMessage" : "listPins",
        roomId: resolveRoomId(),
        messageId,
      });
    }

    if (action === "set-profile") {
      if (ctx.senderIsOwner !== true) {
        throw new ToolAuthorizationError("Matrix profile updates require owner access.");
      }
      const avatarPath =
        readStringParam(params, "avatarPath") ??
        readStringParam(params, "path") ??
        readStringParam(params, "filePath");
      return await dispatch({
        action: "setProfile",
        displayName: readStringParam(params, "displayName") ?? readStringParam(params, "name"),
        avatarUrl: readStringParam(params, "avatarUrl"),
        avatarPath,
      });
    }

    if (action === "member-info") {
      const userId = readStringParam(params, "userId", { required: true });
      return await dispatch({
        action: "memberInfo",
        userId,
        roomId: readStringParam(params, "roomId") ?? readStringParam(params, "channelId"),
      });
    }

    if (action === "channel-info") {
      return await dispatch({
        action: "channelInfo",
        roomId: resolveRoomId(),
      });
    }

    if (action === "permissions") {
      const operation = normalizeLowercaseStringOrEmpty(
        readStringParam(params, "operation") ??
          readStringParam(params, "mode") ??
          "verification-list",
      );
      const operationToAction: Record<string, string> = {
        "encryption-status": "encryptionStatus",
        "verification-status": "verificationStatus",
        "verification-bootstrap": "verificationBootstrap",
        "verification-recovery-key": "verificationRecoveryKey",
        "verification-backup-status": "verificationBackupStatus",
        "verification-backup-restore": "verificationBackupRestore",
        "verification-list": "verificationList",
        "verification-request": "verificationRequest",
        "verification-accept": "verificationAccept",
        "verification-cancel": "verificationCancel",
        "verification-start": "verificationStart",
        "verification-generate-qr": "verificationGenerateQr",
        "verification-scan-qr": "verificationScanQr",
        "verification-sas": "verificationSas",
        "verification-confirm": "verificationConfirm",
        "verification-mismatch": "verificationMismatch",
        "verification-confirm-qr": "verificationConfirmQr",
      };
      const resolvedAction = operationToAction[operation];
      if (!resolvedAction) {
        throw new Error(
          `Unsupported Matrix permissions operation: ${operation}. Supported values: ${Object.keys(
            operationToAction,
          ).join(", ")}`,
        );
      }
      return await dispatch({
        ...params,
        action: resolvedAction,
      });
    }

    throw new Error(`Action ${action} is not supported for provider matrix.`);
  },
};
