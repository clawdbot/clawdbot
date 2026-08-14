import { getSafeLocalStorage } from "../../local-storage.ts";
import { isGatewayMethodAdvertised } from "../gateway-methods.ts";
import { readSessionMethodAccess } from "../session-method-access.ts";
import { readSessionCustomGroupNames, readSidebarSectionOrder } from "./custom-groups.ts";
import type {
  SessionConnectionOwner,
  SessionConnectionScope,
  SessionGateway,
  SessionGroupLoadResult,
  SessionGroupMutationResult,
  SessionState,
} from "./session-capability.ts";

type SessionGroupCatalogHost = {
  connection: SessionConnectionOwner;
  snapshot: () => SessionGateway["snapshot"];
  readState: () => SessionState;
  publish: (state: SessionState, errorSource?: "session-observer" | "operation") => void;
  refreshRows: () => Promise<void>;
  retryDelayMs: (error: unknown) => number | null;
};

const LEGACY_GROUPS_STORAGE_KEY = "openclaw:sessions:custom-groups";
const GROUPS_LIST_METHOD = "sessions.groups.list";

function readLegacyStoredGroups(): string[] {
  try {
    const raw = getSafeLocalStorage()?.getItem(LEGACY_GROUPS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? [
          ...new Set(
            parsed.flatMap((name) => {
              const normalized = typeof name === "string" ? name.trim() : "";
              return normalized ? [normalized] : [];
            }),
          ),
        ]
      : [];
  } catch {
    return [];
  }
}

export function createSessionGroupCatalog(host: SessionGroupCatalogHost) {
  let loadedEpoch = -1;
  let loadGeneration = 0;
  // Consumers joining the current load must wait for the same catalog snapshot;
  // an epoch marker alone would let them observe pre-hydration empty state.
  let activeLoad: { epoch: number; promise: Promise<SessionGroupLoadResult> } | null = null;
  let retryTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

  const clearRetry = () => {
    if (retryTimer !== null) {
      globalThis.clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const invalidate = () => {
    loadedEpoch = -1;
    loadGeneration += 1;
    activeLoad = null;
    clearRetry();
  };

  const publishCatalog = (groups: readonly string[], sectionOrder: readonly string[]) => {
    const state = host.readState();
    const groupsUnchanged =
      groups.length === state.groups.length &&
      groups.every((group, i) => group === state.groups[i]);
    const orderUnchanged =
      sectionOrder.length === state.sectionOrder.length &&
      sectionOrder.every((sectionId, i) => sectionId === state.sectionOrder[i]);
    if (!groupsUnchanged || !orderUnchanged) {
      host.publish({ ...state, groups: [...groups], sectionOrder: [...sectionOrder] });
    }
  };

  const finishMutationFailure = (current: boolean, error: unknown): SessionGroupMutationResult => {
    if (!current) {
      return "stale";
    }
    host.publish({ ...host.readState(), error: String(error) }, "operation");
    throw error;
  };

  const loadAttempt = async (
    scope: SessionConnectionScope,
    generation: number,
    advertised: boolean | null,
  ): Promise<SessionGroupLoadResult> => {
    try {
      const listed = await scope.client.request(GROUPS_LIST_METHOD, {});
      if (!host.connection.isCurrent(scope) || generation !== loadGeneration) {
        return "stale";
      }
      let names = readSessionCustomGroupNames(listed);
      let sectionOrder = readSidebarSectionOrder(listed);
      // Browser-local catalogs predate the gateway store and migrate exactly once.
      const legacy = readLegacyStoredGroups();
      const legacyMigrationAccess = readSessionMethodAccess(host.snapshot(), {
        method: "sessions.groups.put",
        requiredScope: "operator.write",
      });
      if (names.length === 0 && legacy.length > 0 && legacyMigrationAccess.allowed) {
        const put = await scope.client.request("sessions.groups.put", { names: legacy });
        if (!host.connection.isCurrent(scope) || generation !== loadGeneration) {
          return "stale";
        }
        names = readSessionCustomGroupNames(put);
        sectionOrder = readSidebarSectionOrder(put);
      }
      if (legacy.length > 0 && legacyMigrationAccess.allowed) {
        try {
          getSafeLocalStorage()?.removeItem(LEGACY_GROUPS_STORAGE_KEY);
        } catch {
          // The gateway catalog is canonical even when browser cleanup fails.
        }
      }
      publishCatalog(names, sectionOrder);
      return "completed";
    } catch (error) {
      if (
        !host.connection.isCurrent(scope) ||
        generation !== loadGeneration ||
        advertised !== true
      ) {
        // Gateways without feature metadata retain the legacy one-shot probe.
        return host.connection.isCurrent(scope) ? "completed" : "stale";
      }
      loadedEpoch = -1;
      const delay = host.retryDelayMs(error);
      if (delay === null) {
        return "failed";
      }
      // An older rejection cannot revive retries after a newer catalog load wins.
      retryTimer = globalThis.setTimeout(() => {
        retryTimer = null;
        if (host.connection.isCurrent(scope) && generation === loadGeneration) {
          void load();
        }
      }, delay);
      return "failed";
    }
  };

  /** Group consumers may probe once per connection; explicitly absent features never probe. */
  const load = async () => {
    const scope = host.connection.capture();
    if (!scope) {
      return "stale" as const;
    }
    const inFlight = activeLoad;
    if (inFlight?.epoch === scope.epoch) {
      return await inFlight.promise;
    }
    if (loadedEpoch === scope.epoch) {
      return "completed" as const;
    }
    const advertised = isGatewayMethodAdvertised(host.snapshot(), GROUPS_LIST_METHOD);
    clearRetry();
    const generation = ++loadGeneration;
    loadedEpoch = scope.epoch;
    if (advertised === false) {
      publishCatalog([], []);
      return "completed" as const;
    }
    const pending = {
      epoch: scope.epoch,
      promise: loadAttempt(scope, generation, advertised),
    };
    activeLoad = pending;
    try {
      return await pending.promise;
    } finally {
      if (activeLoad === pending) {
        activeLoad = null;
      }
    }
  };

  const put = async (
    names: readonly string[],
    sectionOrder?: readonly string[],
  ): Promise<SessionGroupMutationResult> => {
    const scope = host.connection.capture();
    if (!scope) {
      return "stale";
    }
    try {
      const result = await scope.client.request("sessions.groups.put", {
        names: [...names],
        ...(sectionOrder === undefined ? {} : { sectionOrder: [...sectionOrder] }),
      });
      if (!host.connection.isCurrent(scope)) {
        return "stale";
      }
      publishCatalog(readSessionCustomGroupNames(result), readSidebarSectionOrder(result));
      return "completed";
    } catch (error) {
      return finishMutationFailure(host.connection.isCurrent(scope), error);
    }
  };

  const rename = async (from: string, to: string): Promise<SessionGroupMutationResult> => {
    const scope = host.connection.capture();
    if (!scope) {
      return "stale";
    }
    try {
      const result = await scope.client.request("sessions.groups.rename", { name: from, to });
      if (!host.connection.isCurrent(scope)) {
        return "stale";
      }
      publishCatalog(readSessionCustomGroupNames(result), readSidebarSectionOrder(result));
      // Mutation response commits before a background member-row reconciliation.
      void host.refreshRows();
      return "completed";
    } catch (error) {
      return finishMutationFailure(host.connection.isCurrent(scope), error);
    }
  };

  const remove = async (name: string): Promise<SessionGroupMutationResult> => {
    const scope = host.connection.capture();
    if (!scope) {
      return "stale";
    }
    try {
      const result = await scope.client.request("sessions.groups.delete", { name });
      if (!host.connection.isCurrent(scope)) {
        return "stale";
      }
      publishCatalog(readSessionCustomGroupNames(result), readSidebarSectionOrder(result));
      void host.refreshRows();
      return "completed";
    } catch (error) {
      return finishMutationFailure(host.connection.isCurrent(scope), error);
    }
  };

  return { delete: remove, dispose: invalidate, invalidate, load, put, rename };
}
