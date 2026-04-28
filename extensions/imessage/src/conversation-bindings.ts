import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import {
  createAccountScopedConversationBindingManager,
  resetAccountScopedConversationBindingsForTests,
  type AccountScopedConversationBindingManager,
  type BindingTargetKind,
} from "openclaw/plugin-sdk/thread-bindings-runtime";

type IMessageBindingTargetKind = "subagent" | "acp";

type IMessageConversationBindingManager =
  AccountScopedConversationBindingManager<IMessageBindingTargetKind>;

const IMESSAGE_CONVERSATION_BINDINGS_STATE_KEY = Symbol.for(
  "openclaw.imessageConversationBindingsState",
);

function toSessionBindingTargetKind(raw: IMessageBindingTargetKind): BindingTargetKind {
  return raw === "subagent" ? "subagent" : "session";
}

function toIMessageTargetKind(raw: BindingTargetKind): IMessageBindingTargetKind {
  return raw === "subagent" ? "subagent" : "acp";
}

export function createIMessageConversationBindingManager(params: {
  accountId?: string;
  cfg: OpenClawConfig;
}): IMessageConversationBindingManager {
  return createAccountScopedConversationBindingManager({
    channel: "imessage",
    cfg: params.cfg,
    accountId: params.accountId,
    stateKey: IMESSAGE_CONVERSATION_BINDINGS_STATE_KEY,
    toStoredTargetKind: toIMessageTargetKind,
    toSessionBindingTargetKind,
  });
}

export const __testing = {
  resetIMessageConversationBindingsForTests() {
    resetAccountScopedConversationBindingsForTests({
      stateKey: IMESSAGE_CONVERSATION_BINDINGS_STATE_KEY,
    });
  },
};
