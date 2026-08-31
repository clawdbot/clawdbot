import {
  enumerateConversationKeyForms,
  type IMessageApprovalConversationKey,
} from "./approval-target-keys.js";

type BindingWindow = {
  done: Promise<void>;
  close: () => void;
};

const pendingByConversation = new Map<string, Set<BindingWindow>>();

function approvalControlBindingAbortError(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  return reason instanceof Error
    ? reason
    : new Error("iMessage approval control binding aborted", { cause: reason });
}

function bindingKeys(accountId: string, conversation: IMessageApprovalConversationKey): string[] {
  const account = accountId.trim();
  return account
    ? enumerateConversationKeyForms(conversation).map((form) => `${account}:${form}`)
    : [];
}

/** Marks the send-to-binding interval during which a visible control is not yet resolvable. */
function beginIMessageApprovalControlBinding(params: {
  accountId: string;
  conversation: IMessageApprovalConversationKey;
}): { close: () => void } {
  const keys = bindingKeys(params.accountId, params.conversation);
  let resolveDone = () => {};
  const window: BindingWindow = {
    done: new Promise<void>((resolve) => {
      resolveDone = resolve;
    }),
    close: () => {},
  };
  let closed = false;
  window.close = () => {
    if (closed) {
      return;
    }
    closed = true;
    for (const key of keys) {
      const windows = pendingByConversation.get(key);
      windows?.delete(window);
      if (windows?.size === 0) {
        pendingByConversation.delete(key);
      }
    }
    resolveDone();
  };
  for (const key of keys) {
    const windows = pendingByConversation.get(key) ?? new Set<BindingWindow>();
    windows.add(window);
    pendingByConversation.set(key, windows);
  }
  return { close: window.close };
}

/** Waits for one matching delivery to finish binding; callers recheck until none remain. */
async function waitForIMessageApprovalControlBinding(params: {
  accountId: string;
  conversation: IMessageApprovalConversationKey;
  abortSignal?: AbortSignal;
}): Promise<boolean> {
  const windows = new Set<BindingWindow>();
  for (const key of bindingKeys(params.accountId, params.conversation)) {
    for (const window of pendingByConversation.get(key) ?? []) {
      windows.add(window);
    }
  }
  if (windows.size === 0) {
    return false;
  }
  if (params.abortSignal?.aborted) {
    throw approvalControlBindingAbortError(params.abortSignal);
  }
  let detachAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(approvalControlBindingAbortError(params.abortSignal));
    params.abortSignal?.addEventListener("abort", onAbort, { once: true });
    detachAbort = () => params.abortSignal?.removeEventListener("abort", onAbort);
  });
  try {
    await Promise.race([Promise.race([...windows].map((window) => window.done)), aborted]);
  } finally {
    detachAbort();
  }
  return true;
}

function clearIMessageApprovalControlBindingsForTest(): void {
  for (const windows of pendingByConversation.values()) {
    for (const window of windows) {
      window.close();
    }
  }
  pendingByConversation.clear();
}

export const iMessageApprovalControlBindings = {
  begin: beginIMessageApprovalControlBinding,
  wait: waitForIMessageApprovalControlBinding,
  clearForTest: clearIMessageApprovalControlBindingsForTest,
};
