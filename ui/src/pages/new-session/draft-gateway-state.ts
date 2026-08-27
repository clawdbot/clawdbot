import { initialState, Task, TaskStatus } from "@lit/task";
import type { ReactiveControllerHost } from "lit";
import type {
  UsersPrefsGetResult,
  UsersPrefsSetResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { t } from "../../i18n/index.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import * as catalog from "./catalog-target.ts";
import {
  CLOUD_PROFILE_RETRY_DELAYS_MS,
  discoverPlaceCatalog,
  selectProfiles,
} from "./cloud-profile-discovery.ts";
import type { DraftCloudProfile, DraftEnvironment } from "./discovery.ts";
import { discoverGatewayName } from "./gateway-name-discovery.ts";
import type { NewSessionRouteData } from "./location.ts";
import {
  decodeIdentityPreferences,
  encodeIdentityPreferences,
  loadBrowserPreferences,
  loadNewSessionPreference,
  patchNewSessionPreference,
  PREFS_MIGRATION_KEY,
  replaceBrowserPreference,
  type NewSessionPreference,
} from "./preferences.ts";
import {
  resolveScope,
  resolveSubmissionOutcomeReason,
  type SubmissionOutcomeReason,
} from "./session-placement-recovery-state.ts";

const CATALOG_RETRY_DELAYS_MS = [0, 1_000, 3_000] as const;

type DraftGatewaySnapshot = Readonly<{
  context: ApplicationContext | undefined;
  data: NewSessionRouteData | undefined;
  isConnected: boolean;
  isAdmin: boolean;
  canStartAsDraft: boolean;
  visibility: "normal" | "draft" | "incognito";
  cloudProfileId: string;
  pendingPlacement: Readonly<{
    sessionKey: string;
    gatewayUrl: string;
    recoveryScope: string;
  }>;
  agentsHydrated: boolean;
}>;

type DraftGatewayCallbacks = {
  requestUpdate: () => void;
  updateComplete: () => Promise<unknown>;
  onInvalidate: (resetHostSelection: boolean, outcome: SubmissionOutcomeReason) => void;
  onVisibilityRetired: () => void;
  onCloudProfileCleared: () => void;
  onCloudState: (error: string | null) => void;
  onPendingPlacementReset: () => void;
  onRecoveryReady: (gatewayUrl: string, recoveryScope: string) => void;
  onAdoptAgentDefaults: () => void;
};

export class DraftGatewayState {
  private gatewayNameValue = "";
  private cloudProfilesValue: DraftCloudProfile[] = [];
  private environmentsValue: DraftEnvironment[] | null = null;
  private cloudProfilesReadyValue = false;
  private catalogRetryingValue = false;
  private gatewaySource: ApplicationContext["gateway"] | null = null;
  private gatewayClientValue: ApplicationContext["gateway"]["snapshot"]["client"] = null;
  private gatewayUrlValue = "";
  private gatewayBootIdValue = "";
  private gatewayRecoveryScopeValue = "";
  private gatewayRecoveryScopeReady = false;
  private gatewayConnectedValue = false;
  private gatewayConnectionEpochValue = 0;
  private catalogRetryScope = "";
  private catalogRetryAttempt = 0;
  private catalogRetryTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  private cloudProfileRetryAttempt = 0;
  private cloudProfileRetryTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  private preferenceScope = "";
  private preferenceModeValue: "local" | "loading" | "remote" = "local";
  private identityPreferences: Record<string, NewSessionPreference> = {};
  private preferenceLoad: Promise<void> = Promise.resolve();
  private preferenceWrite: Promise<void> = Promise.resolve();

  private readonly gatewayNameTask: Task<readonly unknown[], string>;
  private readonly cloudProfileTask: Task<
    readonly unknown[],
    { profiles: DraftCloudProfile[]; environments: DraftEnvironment[] }
  >;

  constructor(
    host: ReactiveControllerHost,
    private readonly read: () => DraftGatewaySnapshot,
    private readonly callbacks: DraftGatewayCallbacks,
  ) {
    this.gatewayNameTask = new Task(host, {
      args: () =>
        [
          this.read().isConnected && this.gatewayConnectedValue ? this.gatewayClientValue : null,
          isGatewayMethodAdvertised(this.read().context?.gateway.snapshot ?? {}, "system.info") ===
            true,
          this.gatewayConnectionEpochValue,
        ] as const,
      task: ([client, advertised, _connectionEpoch], { signal }) =>
        discoverGatewayName(client, advertised, signal),
      onComplete: (name) => {
        this.gatewayNameValue = name;
        this.callbacks.requestUpdate();
      },
    });
    this.cloudProfileTask = new Task(host, {
      args: () =>
        [
          this.read().isConnected && this.gatewayConnectedValue ? this.gatewayClientValue : null,
          this.gatewayConnectionEpochValue,
          hasOperatorWriteAccess(this.read().context?.gateway.snapshot.hello?.auth ?? null),
          this.read().isAdmin,
          this.gatewayRecoveryScopeValue,
        ] as const,
      task: ([client, _connectionEpoch, canWrite, isAdmin]) =>
        client ? discoverPlaceCatalog(client, canWrite, isAdmin) : initialState,
      onComplete: (placeCatalog) => {
        this.resetCloudProfileRetry();
        this.environmentsValue = placeCatalog.environments;
        this.applyCloudProfiles(placeCatalog.profiles);
        this.cloudProfilesReadyValue = true;
        this.callbacks.requestUpdate();
      },
      onError: () => {
        // A failed refresh cannot invalidate this Gateway's last successful place catalog.
        this.scheduleCloudProfileRetry();
        this.callbacks.requestUpdate();
      },
    });
  }

  get gatewayName(): string {
    return this.gatewayNameValue;
  }

  get cloudProfiles(): readonly DraftCloudProfile[] {
    return this.cloudProfilesValue;
  }

  get environments(): readonly DraftEnvironment[] | null {
    return this.environmentsValue;
  }

  get cloudProfilesReady(): boolean {
    return this.cloudProfilesReadyValue;
  }

  get cloudProfilesPending(): boolean {
    return this.cloudProfileTask.status === TaskStatus.PENDING;
  }

  get deviceCatalogDisabledReason(): string | undefined {
    // Cached cloud profiles survive refresh failures; live node capacity does not.
    return this.cloudProfilesReadyValue && this.cloudProfileTask.status === TaskStatus.COMPLETE
      ? undefined
      : t("newSession.placementNotReady");
  }

  get catalogRetrying(): boolean {
    return this.catalogRetryingValue;
  }

  get client(): ApplicationContext["gateway"]["snapshot"]["client"] {
    return this.gatewayClientValue;
  }

  get gatewayUrl(): string {
    return this.gatewayUrlValue;
  }

  get recoveryScope(): string {
    return this.gatewayRecoveryScopeValue;
  }

  get sessionCreateScope(): string {
    const scope = [this.gatewayUrlValue, this.gatewayRecoveryScopeValue, this.gatewayBootIdValue];
    return scope.every(Boolean) ? JSON.stringify(scope) : "";
  }

  get connected(): boolean {
    return this.gatewayConnectedValue;
  }

  get connectionEpoch(): number {
    return this.gatewayConnectionEpochValue;
  }

  get preferenceLoading(): boolean {
    return this.preferenceModeValue === "loading";
  }

  resolvedGroupCategory(): string | undefined {
    const snapshot = this.read();
    return isGatewayMethodAdvertised(
      snapshot.context?.gateway.snapshot ?? {},
      "sessions.groups.defaults",
    ) === true
      ? catalog.resolvedGroupName(snapshot.data, snapshot.context?.sessions)
      : undefined;
  }

  refreshCloudProfiles() {
    return this.cloudProfileTask.run();
  }

  synchronize(gateway: ApplicationContext["gateway"]) {
    const snapshot = gateway.snapshot;
    const connected = snapshot.phase === "connected";
    const firstBind = this.gatewaySource === null;
    // The Gateway's idempotency ledger is process-local; a new boot cannot safely replay a start.
    const bootId = connected
      ? (snapshot.hello?.server?.bootId?.trim() ?? "")
      : this.gatewayBootIdValue;
    const gatewayBootChanged =
      !firstBind &&
      connected &&
      Boolean(this.gatewayBootIdValue) &&
      bootId !== this.gatewayBootIdValue;
    const gatewayUrlChanged = !firstBind && this.gatewayUrlValue !== gateway.connection.gatewayUrl;
    const gatewaySourceChanged = !firstBind && this.gatewaySource !== gateway;
    const identityChanged =
      !firstBind && (gatewaySourceChanged || this.gatewayClientValue !== snapshot.client);
    const connectionChanged = !firstBind && this.gatewayConnectedValue !== connected;
    const becameConnected = connected && (identityChanged || !this.gatewayConnectedValue);
    const recoveryScopeBecameReady =
      connected && snapshot.client?.recoveryScopeReady === true && !this.gatewayRecoveryScopeReady;
    const recoveryScope = resolveScope(
      { client: snapshot.client, connected },
      this.gatewayRecoveryScopeValue,
      firstBind,
    );
    this.gatewaySource = gateway;
    this.gatewayClientValue = snapshot.client;
    this.gatewayUrlValue = gateway.connection.gatewayUrl;
    this.gatewayBootIdValue = bootId;
    this.gatewayRecoveryScopeValue = recoveryScope.next;
    this.gatewayRecoveryScopeReady = snapshot.client?.recoveryScopeReady === true;
    this.gatewayConnectedValue = connected;
    if (this.read().visibility === "draft" && !this.read().canStartAsDraft) {
      this.callbacks.onVisibilityRetired();
    }
    if (
      gatewayUrlChanged ||
      gatewayBootChanged ||
      identityChanged ||
      connectionChanged ||
      recoveryScope.changed
    ) {
      const ownerChanged = gatewaySourceChanged || gatewayUrlChanged || recoveryScope.changed;
      const gatewayIdentityChanged = gatewayUrlChanged || recoveryScope.changed;
      this.invalidateDiscovery(
        ownerChanged,
        resolveSubmissionOutcomeReason({
          gatewayIdentityChanged,
          placementDraftOwned: Boolean(this.read().pendingPlacement.sessionKey),
        }),
      );
    }
    if (
      firstBind ||
      gatewayUrlChanged ||
      recoveryScope.changed ||
      recoveryScopeBecameReady ||
      becameConnected
    ) {
      const pending = this.read().pendingPlacement;
      if (
        pending.gatewayUrl &&
        (pending.gatewayUrl !== this.gatewayUrlValue ||
          pending.recoveryScope !== this.gatewayRecoveryScopeValue)
      ) {
        this.callbacks.onPendingPlacementReset();
      }
      if (connected && snapshot.client?.recoveryScopeReady) {
        this.callbacks.onRecoveryReady(this.gatewayUrlValue, this.gatewayRecoveryScopeValue);
      }
    }
    if (becameConnected) {
      this.gatewayConnectionEpochValue += 1;
      this.retryPendingCatalogTarget();
    }
    this.synchronizeIdentityPreferences(snapshot.selfUser?.id);
    this.callbacks.requestUpdate();
  }

  invalidateDiscovery(resetHostSelection: boolean, submissionOutcome: SubmissionOutcomeReason) {
    this.gatewayNameValue = "";
    this.cloudProfilesValue = [];
    this.cloudProfilesReadyValue = false;
    if (resetHostSelection) {
      this.environmentsValue = null;
    }
    this.resetCloudProfileRetry();
    this.callbacks.onInvalidate(resetHostSelection, submissionOutcome);
    this.callbacks.requestUpdate();
  }

  retryPendingCatalogTarget() {
    const { context, data } = this.read();
    if (this.catalogRetryingValue) {
      return;
    }
    if (data?.group && context?.sessions.groupsStatus() === "loading") {
      globalThis.clearTimeout(this.catalogRetryTimer);
      this.catalogRetryTimer = undefined;
      return;
    }
    if (!this.gatewayConnectedValue || !catalog.isRoutePending(data, context?.sessions)) {
      globalThis.clearTimeout(this.catalogRetryTimer);
      this.catalogRetryTimer = undefined;
      this.catalogRetryScope = "";
      this.catalogRetryAttempt = 0;
      return;
    }
    const retryScope = `${this.gatewayConnectionEpochValue}:${catalog.routeKey(data)}`;
    if (this.catalogRetryScope !== retryScope) {
      globalThis.clearTimeout(this.catalogRetryTimer);
      this.catalogRetryTimer = undefined;
      this.catalogRetryScope = retryScope;
      this.catalogRetryAttempt = 0;
    }
    if (this.catalogRetryTimer || this.catalogRetryAttempt >= CATALOG_RETRY_DELAYS_MS.length) {
      return;
    }
    const delayMs = CATALOG_RETRY_DELAYS_MS[this.catalogRetryAttempt];
    this.catalogRetryAttempt += 1;
    this.catalogRetryTimer = globalThis.setTimeout(() => {
      this.catalogRetryTimer = undefined;
      const current = this.read();
      if (
        this.catalogRetryScope !== retryScope ||
        !this.gatewayConnectedValue ||
        (current.data?.group && current.context?.sessions.groupsStatus() === "loading") ||
        !catalog.isRoutePending(current.data, current.context?.sessions)
      ) {
        return;
      }
      if (current.data?.group) {
        current.context?.sessions.groupsInvalidate();
      }
      const revalidation = current.context?.revalidate("new-session");
      if (!revalidation) {
        return;
      }
      void revalidation
        .catch(() => undefined)
        .then(() => this.callbacks.updateComplete())
        .then(() => this.retryPendingCatalogTarget());
    }, delayMs);
  }

  readonly handleCatalogRetry = () => {
    const { context, data } = this.read();
    if (
      this.catalogRetryingValue ||
      !this.gatewayConnectedValue ||
      (data?.group && context?.sessions.groupsStatus() === "loading") ||
      !catalog.isRoutePending(data, context?.sessions)
    ) {
      return;
    }
    if (data?.group) {
      context?.sessions.groupsInvalidate();
    }
    const revalidation = context?.revalidate("new-session");
    if (!revalidation) {
      return;
    }
    globalThis.clearTimeout(this.catalogRetryTimer);
    this.catalogRetryTimer = undefined;
    this.catalogRetryingValue = true;
    this.callbacks.requestUpdate();
    void revalidation
      .catch(() => undefined)
      .then(() => this.callbacks.updateComplete())
      .finally(() => {
        this.catalogRetryingValue = false;
        this.retryPendingCatalogTarget();
        this.callbacks.requestUpdate();
      });
  };

  readPreference(agentId: string): NewSessionPreference | null {
    const snapshot = this.read();
    if (
      catalog.isTarget(snapshot.data) ||
      snapshot.data?.group ||
      snapshot.pendingPlacement.sessionKey
    ) {
      return null;
    }
    return this.preferenceModeValue === "remote"
      ? (this.identityPreferences[normalizeAgentId(agentId)] ?? null)
      : loadNewSessionPreference(this.gatewayUrlValue, agentId);
  }

  persistPreference(agentIdValue: string, workspace: string, patch: NewSessionPreference) {
    const snapshot = this.read();
    if (
      catalog.isTarget(snapshot.data) ||
      snapshot.data?.group ||
      snapshot.pendingPlacement.sessionKey
    ) {
      return;
    }
    const agentId = normalizeAgentId(agentIdValue);
    const nextPatch = { workspace, ...patch };
    if (this.preferenceModeValue === "local") {
      patchNewSessionPreference(this.gatewayUrlValue, agentId, nextPatch);
      return;
    }
    const scope = this.preferenceScope;
    const client = this.gatewayClientValue;
    const gatewayUrl = this.gatewayUrlValue;
    const write = async () => {
      await this.preferenceLoad;
      if (!client || this.preferenceScope !== scope) {
        return;
      }
      if (this.preferenceModeValue === "local") {
        patchNewSessionPreference(gatewayUrl, agentId, nextPatch);
        return;
      }
      const next = { ...this.identityPreferences[agentId], ...nextPatch };
      try {
        const result = await client.request<UsersPrefsSetResult>("users.prefs.set", {
          entries: encodeIdentityPreferences({ [agentId]: next }),
        });
        if (result.status !== "ok" || this.preferenceScope !== scope) {
          return;
        }
        this.identityPreferences = { ...this.identityPreferences, [agentId]: next };
        replaceBrowserPreference(gatewayUrl, agentId, next);
        this.callbacks.requestUpdate();
      } catch {
        // Gateway state is authoritative for identified users; retain the last mirrored value.
      }
    };
    this.preferenceWrite = this.preferenceWrite.then(write, write);
  }

  disconnect() {
    this.gatewaySource = null;
    this.gatewayClientValue = null;
    this.gatewayConnectedValue = false;
    this.gatewayConnectionEpochValue = 0;
    this.catalogRetryScope = "";
    this.catalogRetryAttempt = 0;
    globalThis.clearTimeout(this.catalogRetryTimer);
    this.catalogRetryTimer = undefined;
    void this.gatewayNameTask.run([null, false, -1]);
    void this.cloudProfileTask.run([null, -1, false, false, ""]);
    this.resetCloudProfileRetry();
  }

  private applyCloudProfiles(profiles: DraftCloudProfile[]) {
    const recovery = selectProfiles(
      profiles,
      this.gatewayClientValue,
      this.gatewayRecoveryScopeValue,
    );
    this.cloudProfilesValue = recovery.profiles;
    const snapshot = this.read();
    const pendingPlacement = Boolean(snapshot.pendingPlacement.sessionKey);
    const canWrite = hasOperatorWriteAccess(snapshot.context?.gateway.snapshot.hello?.auth ?? null);
    if ((!this.gatewayConnectedValue || !canWrite) && !pendingPlacement) {
      this.callbacks.onCloudProfileCleared();
    }
    const selectionUnavailable =
      !pendingPlacement &&
      Boolean(snapshot.cloudProfileId) &&
      !profiles.some((profile) => profile.id === snapshot.cloudProfileId);
    if (selectionUnavailable) {
      this.callbacks.onCloudState(t("newSession.catalogUnavailable"));
    } else if (recovery.unsupported) {
      this.callbacks.onCloudState(t("newSession.cloudRecoveryUnavailable"));
    } else {
      this.callbacks.onCloudState(null);
    }
  }

  private resetCloudProfileRetry() {
    globalThis.clearTimeout(this.cloudProfileRetryTimer);
    this.cloudProfileRetryTimer = undefined;
    this.cloudProfileRetryAttempt = 0;
  }

  private scheduleCloudProfileRetry() {
    if (this.cloudProfileRetryTimer || !this.gatewayConnectedValue || !this.gatewayClientValue) {
      return;
    }
    if (this.cloudProfileRetryAttempt >= CLOUD_PROFILE_RETRY_DELAYS_MS.length) {
      if (!this.cloudProfilesReadyValue) {
        this.applyCloudProfiles([]);
        this.cloudProfilesReadyValue = true;
      }
      return;
    }
    const delayMs = CLOUD_PROFILE_RETRY_DELAYS_MS[this.cloudProfileRetryAttempt];
    this.cloudProfileRetryAttempt += 1;
    this.cloudProfileRetryTimer = globalThis.setTimeout(() => {
      this.cloudProfileRetryTimer = undefined;
      if (this.gatewayConnectedValue) {
        void this.cloudProfileTask.run();
      }
    }, delayMs);
  }

  private synchronizeIdentityPreferences(profileId: string | undefined) {
    const client = this.gatewayConnectedValue ? this.gatewayClientValue : null;
    const context = this.read().context;
    const advertised =
      context &&
      isGatewayMethodAdvertised(context.gateway.snapshot, "users.prefs.get") === true &&
      isGatewayMethodAdvertised(context.gateway.snapshot, "users.prefs.set") === true;
    const scope =
      client && profileId && advertised
        ? `${this.gatewayConnectionEpochValue}\0${profileId}`
        : "local";
    if (scope === this.preferenceScope) {
      return;
    }
    this.preferenceScope = scope;
    this.identityPreferences = {};
    if (!client || !profileId || !advertised) {
      this.preferenceModeValue = "local";
      this.preferenceLoad = Promise.resolve();
      return;
    }
    this.preferenceModeValue = "loading";
    this.preferenceLoad = this.loadIdentityPreferences({
      client,
      gatewayUrl: this.gatewayUrlValue,
      scope,
    });
  }

  private async loadIdentityPreferences(params: {
    client: NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;
    gatewayUrl: string;
    scope: string;
  }): Promise<void> {
    try {
      const result = await params.client.request<UsersPrefsGetResult>("users.prefs.get", {});
      if (this.preferenceScope !== params.scope) {
        return;
      }
      if (result.status !== "ok") {
        this.preferenceModeValue = "local";
        return;
      }
      let preferences = decodeIdentityPreferences(result.entries);
      const browserPreferences = loadBrowserPreferences(params.gatewayUrl);
      if (result.entries[PREFS_MIGRATION_KEY] !== true) {
        const missingBrowserPreferences = Object.fromEntries(
          Object.entries(browserPreferences).filter(
            ([agentId]) => !Object.hasOwn(preferences, agentId),
          ),
        );
        const migrationEntries = [
          ...Object.entries(encodeIdentityPreferences(missingBrowserPreferences)),
          [PREFS_MIGRATION_KEY, true] as const,
        ];
        let migrationFailed = false;
        for (let offset = 0; offset < migrationEntries.length; offset += 32) {
          const batch = Object.fromEntries(migrationEntries.slice(offset, offset + 32));
          let response: UsersPrefsSetResult;
          try {
            response = await params.client.request<UsersPrefsSetResult>("users.prefs.set", {
              entries: batch,
            });
          } catch {
            migrationFailed = true;
            break;
          }
          if (this.preferenceScope !== params.scope) {
            return;
          }
          if (response.status !== "ok") {
            migrationFailed = true;
            break;
          }
          Object.assign(preferences, decodeIdentityPreferences(batch));
        }
        if (migrationFailed) {
          preferences = { ...browserPreferences, ...preferences };
        }
      }
      this.identityPreferences = preferences;
      this.preferenceModeValue = "remote";
      for (const [agentId, preference] of Object.entries(preferences)) {
        replaceBrowserPreference(params.gatewayUrl, agentId, preference);
      }
      if (this.read().agentsHydrated) {
        this.callbacks.onAdoptAgentDefaults();
      }
      this.callbacks.requestUpdate();
    } catch {
      if (this.preferenceScope === params.scope) {
        this.preferenceModeValue = "local";
        this.callbacks.requestUpdate();
      }
    }
  }
}
