import "./exec-approvals-store.js";

type ExecApprovalsStoreTestApi = {
  reset(): void;
};

function getTesting(): ExecApprovalsStoreTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.execApprovalsStoreTestApi")
  ] as ExecApprovalsStoreTestApi;
}

export const testing: ExecApprovalsStoreTestApi = {
  reset: () => getTesting().reset(),
};
