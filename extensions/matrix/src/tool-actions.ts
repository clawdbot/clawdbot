// Matrix plugin module implements tool actions behavior.
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveMatrixAccountConfig } from "./matrix/accounts.js";
import {
  bootstrapMatrixVerification,
  acceptMatrixVerification,
  cancelMatrixVerification,
  confirmMatrixVerificationReciprocateQr,
  confirmMatrixVerificationSas,
  deleteMatrixMessage,
  editMatrixMessage,
  generateMatrixVerificationQr,
  getMatrixEncryptionStatus,
  getMatrixRoomKeyBackupStatus,
  getMatrixVerificationStatus,
  getMatrixMemberInfo,
  getMatrixRoomInfo,
  getMatrixVerificationSas,
  listMatrixPins,
  listMatrixReactions,
  listMatrixVerifications,
  mismatchMatrixVerificationSas,
  pinMatrixMessage,
  readMatrixMessages,
  requestMatrixVerification,
  restoreMatrixRoomKeyBackup,
  removeMatrixReactions,
  scanMatrixVerificationQr,
  sendMatrixMessage,
  startMatrixVerification,
  unpinMatrixMessage,
  voteMatrixPoll,
  verifyMatrixRecoveryKey,
} from "./matrix/actions.js";
import { withAuthorizedMatrixReadTarget, type MatrixReadContext } from "./matrix/read-policy.js";
import type { MatrixClient } from "./matrix/sdk.js";
import { reactMatrixMessage } from "./matrix/send.js";
import { applyMatrixProfileUpdate } from "./profile-update.js";
import {
  createActionGate,
  jsonResult,
  readPositiveIntegerParam,
  readReactionParams,
  readStringArrayParam,
  readStringParam,
} from "./runtime-api.js";
import type { CoreConfig } from "./types.js";

const messageActions = new Set(["sendMessage", "editMessage", "deleteMessage", "readMessages"]);
const reactionActions = new Set(["react", "reactions"]);
const pinActions = new Set(["pinMessage", "unpinMessage", "listPins"]);
const pollActions = new Set(["pollVote"]);
const profileActions = new Set(["setProfile"]);
const verificationActions = new Set([
  "encryptionStatus",
  "verificationList",
  "verificationRequest",
  "verificationAccept",
  "verificationCancel",
  "verificationStart",
  "verificationGenerateQr",
  "verificationScanQr",
  "verificationSas",
  "verificationConfirm",
  "verificationMismatch",
  "verificationConfirmQr",
  "verificationStatus",
  "verificationBootstrap",
  "verificationRecoveryKey",
  "verificationBackupStatus",
  "verificationBackupRestore",
]);

function readRoomId(params: Record<string, unknown>, required = true): string {
  const direct = readStringParam(params, "roomId") ?? readStringParam(params, "channelId");
  if (direct) {
    return direct;
  }
  if (!required) {
    return readStringParam(params, "to") ?? "";
  }
  return readStringParam(params, "to", { required: true });
}

function toSnakeCaseKey(key: string): string {
  return normalizeOptionalLowercaseString(
    key.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").replace(/([a-z0-9])([A-Z])/g, "$1_$2"),
  )!;
}

function readRawParam(params: Record<string, unknown>, key: string): unknown {
  if (Object.hasOwn(params, key)) {
    return params[key];
  }
  const snakeKey = toSnakeCaseKey(key);
  if (snakeKey !== key && Object.hasOwn(params, snakeKey)) {
    return params[snakeKey];
  }
  return undefined;
}

function readStringAliasParam(
  params: Record<string, unknown>,
  keys: string[],
  options: { required?: boolean } = {},
): string | undefined {
  for (const key of keys) {
    const raw = readRawParam(params, key);
    if (typeof raw !== "string") {
      continue;
    }
    const trimmed = raw.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  if (options.required) {
    throw new Error(`${keys[0]} required`);
  }
  return undefined;
}

function readPositiveIntegerArrayParam(params: Record<string, unknown>, key: string): number[] {
  const raw = readRawParam(params, key);
  if (raw == null) {
    return [];
  }
  return (Array.isArray(raw) ? raw : [raw]).flatMap((value) => {
    if (value == null || value === "") {
      return [];
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) {
        return [];
      }
      if (!/^[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:e[+-]?\d+)?$/i.test(trimmed)) {
        return [];
      }
    }
    const index = readPositiveIntegerParam({ [key]: value }, key, {
      message: `${key} must contain positive integers.`,
    });
    return index === undefined ? [] : [index];
  });
}

export async function handleMatrixAction(
  params: Record<string, unknown>,
  cfg: CoreConfig,
  opts: { mediaLocalRoots?: readonly string[]; readContext?: MatrixReadContext } = {},
): Promise<AgentToolResult<unknown>> {
  const action = readStringParam(params, "action", { required: true });
  const accountId = readStringParam(params, "accountId") ?? undefined;
  const isActionEnabled = createActionGate(resolveMatrixAccountConfig({ cfg, accountId }).actions);
  const clientOpts = {
    cfg,
    ...(accountId ? { accountId } : {}),
  };
  const withReadTarget = async <T>(
    roomId: string,
    run: (target: { roomId: string; client: MatrixClient }) => Promise<T>,
  ) =>
    await withAuthorizedMatrixReadTarget({
      cfg,
      accountId,
      roomId,
      context: opts.readContext,
      opts: clientOpts,
      run,
    });

  if (reactionActions.has(action)) {
    if (!isActionEnabled("reactions")) {
      throw new Error("Matrix reactions are disabled.");
    }
    const roomId = readRoomId(params);
    const messageId = readStringParam(params, "messageId", { required: true });
    if (action === "react") {
      const { emoji, remove, isEmpty } = readReactionParams(params, {
        removeErrorMessage: "Emoji is required to remove a Matrix reaction.",
      });
      if (remove || isEmpty) {
        const result = await withReadTarget(roomId, async (target) => {
          return await removeMatrixReactions(target.roomId, messageId, {
            ...clientOpts,
            client: target.client,
            emoji: remove ? emoji : undefined,
          });
        });
        return jsonResult({ ok: true, removed: result.removed });
      }
      await withReadTarget(roomId, async (target) => {
        await reactMatrixMessage(target.roomId, messageId, emoji, {
          ...clientOpts,
          client: target.client,
        });
      });
      return jsonResult({ ok: true, added: emoji });
    }
    const limit = readPositiveIntegerParam(params, "limit", {
      message: "limit must be a positive integer.",
    });
    const reactions = await withReadTarget(roomId, async (target) => {
      return await listMatrixReactions(target.roomId, messageId, {
        ...clientOpts,
        client: target.client,
        limit: limit ?? undefined,
      });
    });
    return jsonResult({ ok: true, reactions });
  }

  if (pollActions.has(action)) {
    const roomId = readRoomId(params);
    const pollId = readStringAliasParam(params, ["pollId", "messageId"], { required: true });
    if (!pollId) {
      throw new Error("pollId required");
    }
    const optionId = readStringParam(params, "pollOptionId");
    const optionIndex = readPositiveIntegerParam(params, "pollOptionIndex", {
      message: "pollOptionIndex must be a positive integer.",
    });
    const optionIds = [
      ...(readStringArrayParam(params, "pollOptionIds") ?? []),
      ...(optionId ? [optionId] : []),
    ];
    const optionIndexes = [
      ...readPositiveIntegerArrayParam(params, "pollOptionIndexes"),
      ...(optionIndex !== undefined ? [optionIndex] : []),
    ];
    const result = await withReadTarget(roomId, async (target) => {
      return await voteMatrixPoll(target.roomId, pollId, {
        ...clientOpts,
        client: target.client,
        optionIds,
        optionIndexes,
      });
    });
    return jsonResult({ ok: true, result });
  }

  if (messageActions.has(action)) {
    if (!isActionEnabled("messages")) {
      throw new Error("Matrix messages are disabled.");
    }
    switch (action) {
      case "sendMessage": {
        const to = readStringParam(params, "to", { required: true });
        const mediaUrl =
          readStringParam(params, "mediaUrl", { trim: false }) ??
          readStringParam(params, "media", { trim: false }) ??
          readStringParam(params, "filePath", { trim: false }) ??
          readStringParam(params, "path", { trim: false });
        const content = readStringParam(params, "content", {
          required: !mediaUrl,
          allowEmpty: true,
        });
        const replyToId =
          readStringParam(params, "replyToId") ?? readStringParam(params, "replyTo");
        const threadId = readStringParam(params, "threadId");
        const audioAsVoice =
          typeof readRawParam(params, "audioAsVoice") === "boolean"
            ? (readRawParam(params, "audioAsVoice") as boolean)
            : typeof readRawParam(params, "asVoice") === "boolean"
              ? (readRawParam(params, "asVoice") as boolean)
              : undefined;
        const result = await sendMatrixMessage(to, content, {
          mediaUrl: mediaUrl ?? undefined,
          mediaLocalRoots: opts.mediaLocalRoots,
          replyToId: replyToId ?? undefined,
          threadId: threadId ?? undefined,
          audioAsVoice,
          ...clientOpts,
        });
        return jsonResult({ ok: true, result });
      }
      case "editMessage": {
        const roomId = readRoomId(params);
        const messageId = readStringParam(params, "messageId", { required: true });
        const content = readStringParam(params, "content", { required: true });
        const result = await withReadTarget(roomId, async (target) => {
          return await editMatrixMessage(target.roomId, messageId, content, {
            ...clientOpts,
            client: target.client,
          });
        });
        return jsonResult({ ok: true, result });
      }
      case "deleteMessage": {
        const roomId = readRoomId(params);
        const messageId = readStringParam(params, "messageId", { required: true });
        const reason = readStringParam(params, "reason");
        await withReadTarget(roomId, async (target) => {
          await deleteMatrixMessage(target.roomId, messageId, {
            reason: reason ?? undefined,
            ...clientOpts,
            client: target.client,
          });
        });
        return jsonResult({ ok: true, deleted: true });
      }
      case "readMessages": {
        const roomId = readRoomId(params);
        const limit = readPositiveIntegerParam(params, "limit", {
          message: "limit must be a positive integer.",
        });
        const before = readStringParam(params, "before");
        const after = readStringParam(params, "after");
        const threadId = readStringParam(params, "threadId");
        const result = await withReadTarget(roomId, async (target) => {
          const messages = await readMatrixMessages(target.roomId, {
            limit: limit ?? undefined,
            before: before ?? undefined,
            after: after ?? undefined,
            threadId: threadId ?? undefined,
            ...clientOpts,
            client: target.client,
          });
          return {
            ...messages,
            roomId: target.roomId,
            ...(threadId ? { threadId } : {}),
          };
        });
        return jsonResult({ ok: true, ...result });
      }
      default:
        break;
    }
  }

  if (pinActions.has(action)) {
    if (!isActionEnabled("pins")) {
      throw new Error("Matrix pins are disabled.");
    }
    const roomId = readRoomId(params);
    const request =
      action === "pinMessage"
        ? {
            kind: "pin" as const,
            messageId: readStringParam(params, "messageId", { required: true }),
          }
        : action === "unpinMessage"
          ? {
              kind: "unpin" as const,
              messageId: readStringParam(params, "messageId", { required: true }),
            }
          : { kind: "list" as const };
    return await withReadTarget(roomId, async (target) => {
      const actionOpts = {
        ...clientOpts,
        client: target.client,
      };
      if (request.kind === "pin") {
        const result = await pinMatrixMessage(target.roomId, request.messageId, actionOpts);
        return jsonResult({ ok: true, pinned: result.pinned });
      }
      if (request.kind === "unpin") {
        const result = await unpinMatrixMessage(target.roomId, request.messageId, actionOpts);
        return jsonResult({ ok: true, pinned: result.pinned });
      }
      const result = await listMatrixPins(target.roomId, actionOpts);
      return jsonResult({ ok: true, pinned: result.pinned, events: result.events });
    });
  }

  if (profileActions.has(action)) {
    if (!isActionEnabled("profile")) {
      throw new Error("Matrix profile updates are disabled.");
    }
    const avatarPath =
      readStringParam(params, "avatarPath") ??
      readStringParam(params, "path") ??
      readStringParam(params, "filePath");
    const result = await applyMatrixProfileUpdate({
      cfg,
      account: accountId,
      displayName: readStringParam(params, "displayName") ?? readStringParam(params, "name"),
      avatarUrl: readStringParam(params, "avatarUrl"),
      avatarPath,
      mediaLocalRoots: opts.mediaLocalRoots,
    });
    return jsonResult({ ok: true, ...result });
  }

  if (action === "memberInfo") {
    if (!isActionEnabled("memberInfo")) {
      throw new Error("Matrix member info is disabled.");
    }
    const userId = readStringParam(params, "userId", { required: true });
    const roomId = readRoomId(params);
    const result = await withReadTarget(roomId, async (target) => {
      return await getMatrixMemberInfo(userId, {
        roomId: target.roomId,
        ...clientOpts,
        client: target.client,
      });
    });
    return jsonResult({ ok: true, member: result });
  }

  if (action === "channelInfo") {
    if (!isActionEnabled("channelInfo")) {
      throw new Error("Matrix room info is disabled.");
    }
    const roomId = readRoomId(params);
    const result = await withReadTarget(roomId, async (target) => {
      return await getMatrixRoomInfo(target.roomId, {
        ...clientOpts,
        client: target.client,
      });
    });
    return jsonResult({ ok: true, room: result });
  }

  if (verificationActions.has(action)) {
    if (!isActionEnabled("verification")) {
      throw new Error("Matrix verification actions are disabled.");
    }

    const requestId =
      readStringParam(params, "requestId") ??
      readStringParam(params, "verificationId") ??
      readStringParam(params, "id");

    if (action === "encryptionStatus") {
      const includeRecoveryKey = params.includeRecoveryKey === true;
      const status = await getMatrixEncryptionStatus({ includeRecoveryKey, ...clientOpts });
      return jsonResult({ ok: true, status });
    }
    if (action === "verificationStatus") {
      const includeRecoveryKey = params.includeRecoveryKey === true;
      const status = await getMatrixVerificationStatus({ includeRecoveryKey, ...clientOpts });
      return jsonResult({ ok: true, status });
    }
    if (action === "verificationBootstrap") {
      const recoveryKey =
        readStringParam(params, "recoveryKey", { trim: false }) ??
        readStringParam(params, "key", { trim: false });
      const result = await bootstrapMatrixVerification({
        recoveryKey: recoveryKey ?? undefined,
        forceResetCrossSigning: params.forceResetCrossSigning === true,
        ...clientOpts,
      });
      return jsonResult({ ok: result.success, result });
    }
    if (action === "verificationRecoveryKey") {
      const recoveryKey =
        readStringParam(params, "recoveryKey", { trim: false }) ??
        readStringParam(params, "key", { trim: false });
      const result = await verifyMatrixRecoveryKey(
        readStringParam({ recoveryKey }, "recoveryKey", { required: true, trim: false }),
        clientOpts,
      );
      return jsonResult({ ok: result.success, result });
    }
    if (action === "verificationBackupStatus") {
      const status = await getMatrixRoomKeyBackupStatus(clientOpts);
      return jsonResult({ ok: true, status });
    }
    if (action === "verificationBackupRestore") {
      const recoveryKey =
        readStringParam(params, "recoveryKey", { trim: false }) ??
        readStringParam(params, "key", { trim: false });
      const result = await restoreMatrixRoomKeyBackup({
        recoveryKey: recoveryKey ?? undefined,
        ...clientOpts,
      });
      return jsonResult({ ok: result.success, result });
    }
    if (action === "verificationList") {
      const verifications = await listMatrixVerifications(clientOpts);
      return jsonResult({ ok: true, verifications });
    }
    if (action === "verificationRequest") {
      const userId = readStringParam(params, "userId");
      const deviceId = readStringParam(params, "deviceId");
      const roomId = readStringParam(params, "roomId") ?? readStringParam(params, "channelId");
      const ownUser = typeof params.ownUser === "boolean" ? params.ownUser : undefined;
      const verification = await requestMatrixVerification({
        ownUser,
        userId: userId ?? undefined,
        deviceId: deviceId ?? undefined,
        roomId: roomId ?? undefined,
        ...clientOpts,
      });
      return jsonResult({ ok: true, verification });
    }
    if (action === "verificationAccept") {
      const verification = await acceptMatrixVerification(
        readStringParam({ requestId }, "requestId", { required: true }),
        clientOpts,
      );
      return jsonResult({ ok: true, verification });
    }
    if (action === "verificationCancel") {
      const reason = readStringParam(params, "reason");
      const code = readStringParam(params, "code");
      const verification = await cancelMatrixVerification(
        readStringParam({ requestId }, "requestId", { required: true }),
        { reason: reason ?? undefined, code: code ?? undefined, ...clientOpts },
      );
      return jsonResult({ ok: true, verification });
    }
    if (action === "verificationStart") {
      const methodRaw = readStringParam(params, "method");
      const method = normalizeOptionalLowercaseString(methodRaw);
      if (method && method !== "sas") {
        throw new Error(
          "Matrix verificationStart only supports method=sas; use verificationGenerateQr/verificationScanQr for QR flows.",
        );
      }
      const verification = await startMatrixVerification(
        readStringParam({ requestId }, "requestId", { required: true }),
        { method: "sas", ...clientOpts },
      );
      return jsonResult({ ok: true, verification });
    }
    if (action === "verificationGenerateQr") {
      const qr = await generateMatrixVerificationQr(
        readStringParam({ requestId }, "requestId", { required: true }),
        clientOpts,
      );
      return jsonResult({ ok: true, ...qr });
    }
    if (action === "verificationScanQr") {
      const qrDataBase64 =
        readStringParam(params, "qrDataBase64") ??
        readStringParam(params, "qrData") ??
        readStringParam(params, "qr");
      const verification = await scanMatrixVerificationQr(
        readStringParam({ requestId }, "requestId", { required: true }),
        readStringParam({ qrDataBase64 }, "qrDataBase64", { required: true }),
        clientOpts,
      );
      return jsonResult({ ok: true, verification });
    }
    if (action === "verificationSas") {
      const sas = await getMatrixVerificationSas(
        readStringParam({ requestId }, "requestId", { required: true }),
        clientOpts,
      );
      return jsonResult({ ok: true, sas });
    }
    if (action === "verificationConfirm") {
      const verification = await confirmMatrixVerificationSas(
        readStringParam({ requestId }, "requestId", { required: true }),
        clientOpts,
      );
      return jsonResult({ ok: true, verification });
    }
    if (action === "verificationMismatch") {
      const verification = await mismatchMatrixVerificationSas(
        readStringParam({ requestId }, "requestId", { required: true }),
        clientOpts,
      );
      return jsonResult({ ok: true, verification });
    }
    if (action === "verificationConfirmQr") {
      const verification = await confirmMatrixVerificationReciprocateQr(
        readStringParam({ requestId }, "requestId", { required: true }),
        clientOpts,
      );
      return jsonResult({ ok: true, verification });
    }
  }

  throw new Error(`Unsupported Matrix action: ${action}`);
}
