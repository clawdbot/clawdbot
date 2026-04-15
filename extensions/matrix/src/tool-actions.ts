import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
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
import { reactMatrixMessage } from "./matrix/send.js";
import { applyMatrixProfileUpdate } from "./profile-update.js";
import {
  createActionGate,
  jsonResult,
  readNumberParam,
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

function readNumericArrayParam(
  params: Record<string, unknown>,
  key: string,
  options: { integer?: boolean } = {},
): number[] {
  const { integer = false } = options;
  const raw = readRawParam(params, key);
  if (raw === undefined) {
    return [];
  }
  return (Array.isArray(raw) ? raw : [raw])
    .map((value) => {
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) {
          return null;
        }
        const parsed = Number(trimmed);
        return Number.isFinite(parsed) ? parsed : null;
      }
      return null;
    })
    .filter((value): value is number => value !== null)
    .map((value) => (integer ? Math.trunc(value) : value));
}

export async function handleMatrixAction(
  params: Record<string, unknown>,
  cfg: CoreConfig,
  opts: { mediaLocalRoots?: readonly string[] } = {},
): Promise<AgentToolResult<unknown>> {
  const action = readStringParam(params, "action", { required: true });
  const accountId = readStringParam(params, "accountId") ?? undefined;
  const isActionEnabled = createActionGate(resolveMatrixAccountConfig({ cfg, accountId }).actions);
  const clientOpts = {
    cfg,
    ...(accountId ? { accountId } : {}),
  };

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
        const result = await removeMatrixReactions(roomId, messageId, {
          ...clientOpts,
          emoji: remove ? emoji : undefined,
        });
        return jsonResult({ ok: true, removed: result.removed });
      }
      await reactMatrixMessage(roomId, messageId, emoji, clientOpts);
      return jsonResult({ ok: true, added: emoji });
    }
    const limit = readNumberParam(params, "limit", { integer: true });
    const reactions = await listMatrixReactions(roomId, messageId, {
      ...clientOpts,
      limit: limit ?? undefined,
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
    const optionIndex = readNumberParam(params, "pollOptionIndex", { integer: true });
    const optionIds = [
      ...(readStringArrayParam(params, "pollOptionIds") ?? []),
      ...(optionId ? [optionId] : []),
    ];
    const optionIndexes = [
      ...readNumericArrayParam(params, "pollOptionIndexes", { integer: true }),
      ...(optionIndex !== undefined ? [optionIndex] : []),
    ];
    const result = await voteMatrixPoll(roomId, pollId, {
      ...clientOpts,
      optionIds,
      optionIndexes,
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
        const result = await editMatrixMessage(roomId, messageId, content, clientOpts);
        return jsonResult({ ok: true, result });
      }
      case "deleteMessage": {
        const roomId = readRoomId(params);
        const messageId = readStringParam(params, "messageId", { required: true });
        const reason = readStringParam(params, "reason");
        await deleteMatrixMessage(roomId, messageId, {
          reason: reason ?? undefined,
          ...clientOpts,
        });
        return jsonResult({ ok: true, deleted: true });
      }
      case "readMessages": {
        const roomId = readRoomId(params);
        const limit = readNumberParam(params, "limit", { integer: true });
        const before = readStringParam(params, "before");
        const after = readStringParam(params, "after");
        const result = await readMatrixMessages(roomId, {
          limit: limit ?? undefined,
          before: before ?? undefined,
          after: after ?? undefined,
          ...clientOpts,
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
    if (action === "pinMessage") {
      const messageId = readStringParam(params, "messageId", { required: true });
      const result = await pinMatrixMessage(roomId, messageId, clientOpts);
      return jsonResult({ ok: true, pinned: result.pinned });
    }
    if (action === "unpinMessage") {
      const messageId = readStringParam(params, "messageId", { required: true });
      const result = await unpinMatrixMessage(roomId, messageId, clientOpts);
      return jsonResult({ ok: true, pinned: result.pinned });
    }
    const result = await listMatrixPins(roomId, clientOpts);
    return jsonResult({ ok: true, pinned: result.pinned, events: result.events });
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
    const roomId = readStringParam(params, "roomId") ?? readStringParam(params, "channelId");
    const result = await getMatrixMemberInfo(userId, {
      roomId: roomId ?? undefined,
      ...clientOpts,
    });
    return jsonResult({ ok: true, member: result });
  }

  if (action === "channelInfo") {
    if (!isActionEnabled("channelInfo")) {
      throw new Error("Matrix room info is disabled.");
    }
    const roomId = readRoomId(params);
    const result = await getMatrixRoomInfo(roomId, clientOpts);
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
