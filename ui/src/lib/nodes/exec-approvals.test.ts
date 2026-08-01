import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createInitialNodesState,
  loadExecApprovals,
  saveExecApprovals,
  updateExecApprovalsFormValue,
} from "./index.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("host-native exec approvals state", () => {
  it("keeps native snapshots read-only", async () => {
    const request = vi.fn().mockResolvedValue({
      enabled: true,
      hash: "sha256:current",
      defaultAction: "deny",
      rules: [{ pattern: "hostname", action: "allow" }],
    });
    const state = createInitialNodesState({ client: { request }, connected: true });
    const target = { kind: "node" as const, nodeId: "windows-node" };

    await loadExecApprovals(state, target);

    expect(state.execApprovalsForm).toBeNull();
    expect(state.execApprovalsDirty).toBe(false);
    updateExecApprovalsFormValue(state, ["defaults", "security"], "full");
    expect(state.execApprovalsDirty).toBe(false);
    expect(state.lastError).toContain("read-only");

    await saveExecApprovals(state, target);

    expect(request).toHaveBeenCalledTimes(1);
    expect(state.lastError).toContain("read-only");
  });

  it("isolates approval loads across a same-client reconnect", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const request = vi
      .fn<(method: string, params?: unknown) => Promise<unknown>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const client = { request } as unknown as GatewayBrowserClient;
    const state = createInitialNodesState({ client, connected: true });

    const staleLoad = loadExecApprovals(state);
    state.connected = false;
    state.requestGeneration += 1;
    state.execApprovalsLoading = false;
    state.connected = true;
    state.requestGeneration += 1;
    const currentLoad = loadExecApprovals(state);

    first.resolve({ path: "/old", exists: true, hash: "old", file: {} });
    await staleLoad;
    expect(state.execApprovalsSnapshot).toBeNull();
    expect(state.execApprovalsLoading).toBe(true);

    const current = { path: "/new", exists: true, hash: "new", file: {} };
    second.resolve(current);
    await currentLoad;
    expect(state.execApprovalsSnapshot).toEqual(current);
    expect(state.execApprovalsLoading).toBe(false);
  });
});
