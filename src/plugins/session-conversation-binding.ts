import crypto from "node:crypto";
import {
  createConversationBindingRecord,
  resolveConversationBindingRecord,
  unbindConversationBindingRecord,
} from "../bindings/records.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel-constants.js";
import { bindConversationNow, buildPluginBindingIdentity } from "./conversation-binding.js";
import type {
  PluginConversationBinding,
  PluginConversationBindingRequestParams,
} from "./conversation-binding.types.js";

const log = createSubsystemLogger("plugins/binding");

// Serializes bind+finalize+rollback per session so a failing older attempt
// can never unbind or restore over a newer successful one (all session binds
// go through this in-process seam).
const pluginSessionBindTails = new Map<string, Promise<void>>();

/** Binds a plugin-owned runtime to one authenticated Control UI session. */
export async function bindPluginSessionConversation(params: {
  pluginId: string;
  pluginName?: string;
  pluginRoot: string;
  sessionKey: string;
  binding: PluginConversationBindingRequestParams;
  afterBind?: () => Promise<void>;
}): Promise<PluginConversationBinding> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    throw new Error("session key is required for a plugin session binding");
  }
  const previousTail = pluginSessionBindTails.get(sessionKey) ?? Promise.resolve();
  const operation = previousTail.then(() =>
    bindPluginSessionConversationExclusive({ ...params, sessionKey }),
  );
  const tail = operation.then(
    () => undefined,
    () => undefined,
  );
  pluginSessionBindTails.set(sessionKey, tail);
  try {
    return await operation;
  } finally {
    if (pluginSessionBindTails.get(sessionKey) === tail) {
      pluginSessionBindTails.delete(sessionKey);
    }
  }
}

async function bindPluginSessionConversationExclusive(params: {
  pluginId: string;
  pluginName?: string;
  pluginRoot: string;
  sessionKey: string;
  binding: PluginConversationBindingRequestParams;
  afterBind?: () => Promise<void>;
}): Promise<PluginConversationBinding> {
  const sessionKey = params.sessionKey;
  const conversation = {
    channel: INTERNAL_MESSAGE_CHANNEL,
    accountId: "default",
    conversationId: sessionKey,
  };
  const previous = resolveConversationBindingRecord(conversation);
  const bindingAttemptId = crypto.randomUUID();
  const binding = await bindConversationNow({
    identity: buildPluginBindingIdentity(params),
    conversation,
    targetSessionKey: sessionKey,
    summary: params.binding.summary,
    detachHint: params.binding.detachHint,
    data: params.binding.data,
    bindingAttemptId,
  });
  try {
    await params.afterBind?.();
    return binding;
  } catch (error) {
    const current = resolveConversationBindingRecord(conversation);
    if (current?.metadata?.bindingAttemptId !== bindingAttemptId) {
      throw error;
    }
    try {
      await unbindConversationBindingRecord({
        bindingId: current.bindingId,
        reason: "plugin-session-bind-rollback",
      });
      if (previous && (previous.expiresAt === undefined || previous.expiresAt > Date.now())) {
        await createConversationBindingRecord({
          targetSessionKey: previous.targetSessionKey,
          targetKind: previous.targetKind,
          conversation: previous.conversation,
          placement: "current",
          metadata: previous.metadata,
          ...(previous.expiresAt === undefined
            ? {}
            : { ttlMs: Math.max(1, previous.expiresAt - Date.now()) }),
        });
      }
    } catch (rollbackError) {
      // The finalize failure is superseded by the rollback failure on the
      // throw path; keep it observable for diagnosis.
      log.warn("plugin session binding finalization failed before rollback", { error });
      throw new Error(
        "plugin session binding finalization failed and its previous binding could not be restored",
        { cause: rollbackError },
      );
    }
    throw error;
  }
}
