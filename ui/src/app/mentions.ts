import { ConnectErrorDetailCodes } from "@openclaw/gateway-client/browser";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  MentionInboxItem,
  MentionsListResult,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  GatewayRequestError,
  resolveGatewayErrorDetailCode,
  type GatewayBrowserClient,
  type GatewayHelloOk,
} from "../api/gateway.ts";
import { formatUiError } from "../lib/format-error.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import type { ConnectionBootstrapCoordinator } from "./connection-bootstrap.ts";
import type { ApplicationGateway } from "./gateway.ts";

type MentionsSnapshot = {
  phase: "unavailable" | "loading" | "ready" | "error";
  items: readonly MentionInboxItem[];
  dismissing: readonly string[];
  error: string | null;
};

export type MentionsCapability = {
  readonly snapshot: MentionsSnapshot;
  refresh: () => Promise<void>;
  dismiss: (ids: readonly string[]) => Promise<void>;
  subscribe: (listener: () => void) => () => void;
  dispose: () => void;
};

type MentionConnection = {
  client: GatewayBrowserClient;
  hello: GatewayHelloOk;
  connectionRevision: number;
  profileId: string;
  gatewayInstanceId: string;
  result: MentionsListResult | null;
  requiredRevision: number | null;
  dismissing: Set<string>;
  refreshRequested: boolean;
  refreshPromise: Promise<void> | null;
};

/** Owns one profile's temporary Inbox even when no Inbox presenter is mounted. */
export function createMentionsCapability(
  gateway: ApplicationGateway,
  options: { connectionBootstrap?: ConnectionBootstrapCoordinator } = {},
): MentionsCapability {
  let snapshot: MentionsSnapshot = {
    phase: "unavailable",
    items: [],
    dismissing: [],
    error: null,
  };
  let connection: MentionConnection | null = null;
  let disposed = false;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<MentionsSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) {
      listener();
    }
  };
  const isCurrent = (owner: MentionConnection) =>
    !disposed &&
    connection === owner &&
    canCallGatewayMethod(gateway.snapshot, "mentions.list", "operator.read") &&
    gateway.snapshot.client === owner.client &&
    gateway.snapshot.hello === owner.hello &&
    gateway.connectionRevision === owner.connectionRevision &&
    gateway.snapshot.selfUser?.identity?.id === owner.profileId;

  const applyResult = (owner: MentionConnection, result: MentionsListResult) => {
    if (
      !isCurrent(owner) ||
      result.gatewayInstanceId !== owner.gatewayInstanceId ||
      (owner.result !== null && result.revision < owner.result.revision) ||
      (owner.requiredRevision !== null && result.revision < owner.requiredRevision)
    ) {
      return;
    }
    owner.result = result;
    publish({ phase: "ready", items: result.items, error: null });
  };

  const handleError = (owner: MentionConnection, error: unknown) => {
    if (!isCurrent(owner)) {
      return;
    }
    const accessLost =
      error instanceof GatewayRequestError &&
      (error.gatewayCode === "FORBIDDEN" ||
        resolveGatewayErrorDetailCode(error) ===
          ConnectErrorDetailCodes.AUTHENTICATED_PROFILE_UNAVAILABLE);
    if (accessLost) {
      // Retire in-flight reads too; an earlier success cannot restore a revoked Inbox.
      connection = null;
    }
    publish({
      phase: "error",
      error: formatUiError(error),
      ...(accessLost ? { items: [], dismissing: [] } : {}),
    });
  };

  const refreshOwner = (owner: MentionConnection): Promise<void> => {
    if (!isCurrent(owner)) {
      return Promise.resolve();
    }
    owner.refreshRequested = true;
    if (owner.refreshPromise) {
      return owner.refreshPromise;
    }
    const run = async () => {
      while (isCurrent(owner) && owner.refreshRequested) {
        owner.refreshRequested = false;
        publish({ phase: "loading", error: null });
        if (!isCurrent(owner)) {
          return;
        }
        try {
          const result = await owner.client.request<MentionsListResult>("mentions.list", {});
          applyResult(owner, result);
        } catch (error) {
          handleError(owner, error);
        }
        // An invalidation during a read gets one more authoritative snapshot;
        // revisions also fence an older read that finishes after dismissal.
      }
    };
    owner.refreshPromise = Promise.resolve().then(async () => {
      try {
        await run();
      } finally {
        owner.refreshPromise = null;
        if (isCurrent(owner) && owner.refreshRequested) {
          await refreshOwner(owner);
        }
      }
    });
    return owner.refreshPromise;
  };

  const synchronize = () => {
    const next = gateway.snapshot;
    const profileId = next.selfUser?.identity?.id;
    const gatewayInstanceId = next.hello?.server?.bootId;
    if (connection && isCurrent(connection)) {
      return;
    }
    if (
      disposed ||
      next.phase !== "connected" ||
      !next.client ||
      !next.hello ||
      !profileId ||
      !gatewayInstanceId ||
      !canCallGatewayMethod(next, "mentions.list", "operator.read")
    ) {
      connection = null;
      publish({ phase: "unavailable", items: [], dismissing: [], error: null });
      return;
    }
    const owner: MentionConnection = {
      client: next.client,
      hello: next.hello,
      connectionRevision: gateway.connectionRevision,
      profileId,
      gatewayInstanceId,
      result: null,
      requiredRevision: null,
      dismissing: new Set(),
      refreshRequested: false,
      refreshPromise: null,
    };
    connection = owner;
    publish({ phase: "loading", items: [], dismissing: [], error: null });
    if (!isCurrent(owner)) {
      return;
    }
    const hydrate = () => refreshOwner(owner);
    const bootstrapKey = `mentions:${gatewayInstanceId}:${next.hello.server?.connId}:${profileId}`;
    void (options.connectionBootstrap?.run(bootstrapKey, hydrate) ?? hydrate());
  };

  // Subscribe before hydration so a commit cannot fall between the initial
  // snapshot and the profile's targeted invalidation stream.
  const stopEvents = gateway.subscribeEvents((event) => {
    const owner = connection;
    if (event.event !== "mentions.changed" || !owner || !isCurrent(owner)) {
      return;
    }
    const payload = isRecord(event.payload) ? event.payload : undefined;
    if (
      payload?.gatewayInstanceId !== owner.gatewayInstanceId ||
      typeof payload.revision !== "number" ||
      !Number.isSafeInteger(payload.revision) ||
      payload.revision < 0 ||
      (owner.result !== null && payload.revision <= owner.result.revision)
    ) {
      return;
    }
    owner.requiredRevision = Math.max(owner.requiredRevision ?? 0, payload.revision);
    void refreshOwner(owner);
  });
  const stopGateway = gateway.subscribe(synchronize);
  synchronize();

  return {
    get snapshot() {
      return snapshot;
    },
    refresh: () => {
      if (!connection) {
        synchronize();
      }
      return connection ? refreshOwner(connection) : Promise.resolve();
    },
    async dismiss(ids) {
      const owner = connection;
      if (
        !owner ||
        !isCurrent(owner) ||
        !canCallGatewayMethod(gateway.snapshot, "mentions.dismiss", "operator.read")
      ) {
        return;
      }
      const visibleIds = new Set(snapshot.items.map((item) => item.id));
      const pendingIds = [...new Set(ids)].filter(
        (id) => visibleIds.has(id) && !owner.dismissing.has(id),
      );
      if (!pendingIds.length) {
        return;
      }
      for (const id of pendingIds) {
        owner.dismissing.add(id);
      }
      publish({ dismissing: [...owner.dismissing], error: null });
      try {
        if (!isCurrent(owner)) {
          return;
        }
        const result = await owner.client.request<MentionsListResult>("mentions.dismiss", {
          ids: pendingIds,
        });
        applyResult(owner, result);
      } catch (error) {
        handleError(owner, error);
      } finally {
        for (const id of pendingIds) {
          owner.dismissing.delete(id);
        }
        if (isCurrent(owner)) {
          publish({ dismissing: [...owner.dismissing] });
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      connection = null;
      stopGateway();
      stopEvents();
      listeners.clear();
    },
  };
}
