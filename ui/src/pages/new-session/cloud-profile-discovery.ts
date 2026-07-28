import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { requestCloudProfiles } from "./cloud-target.ts";
import type { DraftCloudProfile } from "./discovery.ts";

const RETRY_DELAYS_MS = [1_000, 3_000, 10_000, 30_000, 60_000] as const;

type CloudProfileDiscoverySnapshot = {
  connected: boolean;
  client: Pick<GatewayBrowserClient, "request"> | null;
  admin: boolean;
  pendingCloud: boolean;
  selectedId: string;
};

export function selectProfiles(
  profiles: DraftCloudProfile[],
  client: { recoveryScopeReady?: boolean } | null,
  recoveryScope: string,
): { profiles: DraftCloudProfile[]; unsupported: boolean } {
  const unsupported = profiles.length > 0 && client?.recoveryScopeReady === true && !recoveryScope;
  return { profiles: unsupported ? [] : profiles, unsupported };
}

export class CloudProfileDiscovery {
  private requestToken = 0;
  private retryAttempt = 0;
  private retryTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

  constructor(
    private readonly host: {
      snapshot: () => CloudProfileDiscoverySnapshot;
      update: (params: {
        profiles: DraftCloudProfile[];
        hydrated: boolean;
        clearSelection?: boolean;
        selectionUnavailable?: boolean;
      }) => void;
    },
  ) {}

  invalidate() {
    this.requestToken += 1;
    globalThis.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.retryAttempt = 0;
    this.host.update({ profiles: [], hydrated: false });
  }

  stop() {
    globalThis.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  async load() {
    const requestId = ++this.requestToken;
    this.host.update({ profiles: [], hydrated: false });
    const snapshot = this.host.snapshot();
    if (!snapshot.connected || !snapshot.client || !snapshot.admin) {
      this.resetRetry();
      this.host.update({
        profiles: [],
        hydrated: true,
        clearSelection: !snapshot.pendingCloud,
      });
      return;
    }
    try {
      const profiles = await requestCloudProfiles(snapshot.client);
      if (requestId !== this.requestToken) {
        return;
      }
      this.resetRetry();
      this.host.update({
        profiles,
        hydrated: true,
        selectionUnavailable:
          !snapshot.pendingCloud &&
          Boolean(snapshot.selectedId) &&
          !profiles.some((profile) => profile.id === snapshot.selectedId),
      });
    } catch {
      if (requestId === this.requestToken) {
        this.host.update({ profiles: [], hydrated: false });
        this.scheduleRetry();
      }
    }
  }

  private resetRetry() {
    globalThis.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.retryAttempt = 0;
  }

  private scheduleRetry() {
    const snapshot = this.host.snapshot();
    if (this.retryTimer || !snapshot.connected || !snapshot.client) {
      return;
    }
    if (this.retryAttempt >= RETRY_DELAYS_MS.length) {
      this.host.update({
        profiles: [],
        hydrated: true,
        selectionUnavailable: !snapshot.pendingCloud && Boolean(snapshot.selectedId),
      });
      return;
    }
    const delayMs = RETRY_DELAYS_MS[this.retryAttempt];
    this.retryAttempt += 1;
    this.retryTimer = globalThis.setTimeout(() => {
      this.retryTimer = undefined;
      if (this.host.snapshot().connected) {
        void this.load();
      }
    }, delayMs);
  }
}
