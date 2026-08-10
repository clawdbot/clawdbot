import { AsyncLocalStorage } from "node:async_hooks";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

const MAX_CONVERSATION_LIST_ITEMS = 100;
const CONVERSATION_REF_PATTERN = /^conv_[a-f0-9]{32}$/u;
const activeConversationAuthority = new AsyncLocalStorage<CodeModePrivateAuthority>();

type CodeModeConversationAddress = {
  conversationRef: string;
  channel: string;
  accountId: string;
  kind: "direct" | "group" | "channel";
  target: string;
  threadId?: string;
};

function readConversationAddress(value: unknown): CodeModeConversationAddress | undefined {
  if (
    !isRecord(value) ||
    typeof value.conversationRef !== "string" ||
    !CONVERSATION_REF_PATTERN.test(value.conversationRef) ||
    typeof value.channel !== "string" ||
    !value.channel.trim() ||
    typeof value.accountId !== "string" ||
    !value.accountId.trim() ||
    (value.kind !== "direct" && value.kind !== "group" && value.kind !== "channel") ||
    typeof value.target !== "string" ||
    !value.target.trim() ||
    (value.threadId !== undefined && (typeof value.threadId !== "string" || !value.threadId.trim()))
  ) {
    return undefined;
  }
  return {
    conversationRef: value.conversationRef,
    channel: value.channel.trim().toLowerCase(),
    accountId: value.accountId.trim().toLowerCase(),
    kind: value.kind,
    target: value.target.trim(),
    ...(value.threadId ? { threadId: value.threadId.trim() } : {}),
  };
}

function conversationTuple(address: CodeModeConversationAddress): string {
  return JSON.stringify([
    address.channel,
    address.accountId,
    address.kind,
    address.target,
    address.threadId ?? null,
  ]);
}

/**
 * Opaque process-local authority for one outer Code Mode exec.
 *
 * Private fields keep target provenance out of JSON, worker data, snapshots,
 * and transcript projection. This enforces canonical owner-list provenance,
 * not natural-language intent; ordinary tool policy already owns mutation
 * authority. The same object is retained while a run is parked.
 */
export class CodeModePrivateAuthority {
  readonly #undeliveredBridgeRequestIds = new Set<string>();
  #conversationList?: CodeModeConversationAddress[];
  #pendingConversationListRequestId?: string;
  #conversationSelectionStarted = false;
  #revoked = false;

  beginBridgeFrontier(
    requests: readonly {
      id: string;
      conversationListIntent: boolean;
      conversationListEligible: boolean;
    }[],
  ): void {
    if (this.#revoked || requests.length === 0) {
      return;
    }
    const hadUndeliveredRequests = this.#undeliveredBridgeRequestIds.size > 0;
    const conversationListRequests = requests.filter((request) => request.conversationListIntent);
    for (const request of requests) {
      this.#undeliveredBridgeRequestIds.add(request.id);
    }
    if (conversationListRequests.length === 0) {
      return;
    }

    // Starting any later list invalidates the prior selection immediately.
    this.#conversationSelectionStarted = true;
    this.#conversationList = undefined;
    this.#pendingConversationListRequestId = undefined;
    const [request] = conversationListRequests;
    if (
      !hadUndeliveredRequests &&
      requests.length === 1 &&
      conversationListRequests.length === 1 &&
      request?.conversationListEligible
    ) {
      this.#pendingConversationListRequestId = request.id;
    }
  }

  deliverBridgeSettlements(
    settlements: readonly {
      id: string;
      conversationListResult?: unknown;
    }[],
  ): void {
    for (const settlement of settlements) {
      this.#undeliveredBridgeRequestIds.delete(settlement.id);
    }
    const pendingRequestId = this.#pendingConversationListRequestId;
    if (!pendingRequestId) {
      return;
    }
    const delivered = settlements.find((settlement) => settlement.id === pendingRequestId);
    if (!delivered) {
      return;
    }
    this.#pendingConversationListRequestId = undefined;
    this.#conversationList = undefined;
    const result = delivered.conversationListResult;
    if (
      !isRecord(result) ||
      result.complete !== true ||
      !Array.isArray(result.conversations) ||
      result.conversations.length > MAX_CONVERSATION_LIST_ITEMS
    ) {
      return;
    }
    const conversations = result.conversations.map(readConversationAddress);
    if (conversations.some((conversation) => conversation === undefined)) {
      return;
    }
    this.#conversationList = conversations as CodeModeConversationAddress[];
  }

  consumeConversation(conversationRef: string): CodeModeConversationAddress | boolean {
    if (this.#revoked) {
      return false;
    }
    if (!this.#conversationSelectionStarted) {
      return true;
    }

    // Selection authority is single-use even when validation or delivery fails.
    const conversations = this.#conversationList;
    this.#conversationList = undefined;
    if (!conversations) {
      return false;
    }
    const selected = conversations.filter(
      (conversation) => conversation.conversationRef === conversationRef,
    );
    if (selected.length !== 1) {
      return false;
    }
    const [selectedAddress] = selected;
    if (!selectedAddress) {
      return false;
    }
    const tuple = conversationTuple(selectedAddress);
    return conversations.filter((conversation) => conversationTuple(conversation) === tuple)
      .length === 1
      ? selectedAddress
      : false;
  }

  revoke(): void {
    this.#revoked = true;
    this.#undeliveredBridgeRequestIds.clear();
    this.#conversationSelectionStarted = true;
    this.#conversationList = undefined;
    this.#pendingConversationListRequestId = undefined;
  }
}

/** Scope one nested tool execution to its owning Code Mode run authority. */
export async function runWithCodeModeConversationAuthority<T>(
  authority: CodeModePrivateAuthority,
  operation: () => Promise<T>,
): Promise<T> {
  return await activeConversationAuthority.run(authority, operation);
}

/**
 * Consume the active Code Mode conversation claim.
 *
 * `undefined` means a direct/non-Code-Mode call retains normal authorization.
 */
export function consumeActiveCodeModeConversationAuthority(
  conversationRef: string,
): CodeModeConversationAddress | boolean | undefined {
  return activeConversationAuthority.getStore()?.consumeConversation(conversationRef);
}
