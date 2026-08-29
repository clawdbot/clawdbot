import {
  normalizeUiArtifact,
  type UiArtifact,
  type UiArtifactViewOffer,
} from "@openclaw/gateway-protocol";
import type { SessionProjectionState } from "../browser.js";
import {
  applyMaterializedUiArtifactViews,
  collectMessageUiArtifacts,
  collectToolEventUiArtifacts,
  materializedViewKey,
  reconcileUiArtifacts,
  type ControlModelArtifactProjectionBounds,
} from "./artifact-projection.js";
import {
  ControlModelCommandError,
  type ControlModelConversationHost,
  type ControlModelConversationSnapshot,
  type ControlModelMaterializeViewInput,
  type ControlModelMaterializedView,
} from "./conversation-types.js";
import {
  cloneAndFreeze,
  localError,
  record,
  safeInteger,
  stableStringify,
  text,
} from "./conversation-utils.js";
import type { ControlModelRequestOptions } from "./model.js";

type ConversationArtifactStoreOptions = {
  host: ControlModelConversationHost;
  sessionKey: string;
  assertCommandReady(command: string): void;
  captureEpoch(command: string): number;
  assertEpoch(epoch: number, command: string): void;
  matchesSessionKey(sessionKey: string): boolean;
  getCurrentArtifacts(): ControlModelConversationSnapshot["artifacts"];
  normalizeCommandError(error: unknown, command: string, epoch: number | null): Error;
  publish(): void;
};

export class ConversationArtifactStore {
  readonly #options: ConversationArtifactStoreOptions;
  readonly #live = new Map<string, UiArtifact>();
  readonly #materialized = new Map<string, UiArtifactViewOffer>();
  readonly #retiredMessages = new WeakSet<object>();
  #truncated = false;
  #activeOperations = 0;
  #generation = 0;

  constructor(options: ConversationArtifactStoreOptions) {
    this.#options = options;
  }

  get truncated(): boolean {
    return this.#truncated;
  }

  get hasActiveOperations(): boolean {
    return this.#activeOperations > 0;
  }

  beginEpoch(entries: SessionProjectionState["entries"]): void {
    for (const entry of entries) {
      if (entry.live && entry.message !== null && typeof entry.message === "object") {
        this.#retiredMessages.add(entry.message);
      }
    }
    this.#live.clear();
    this.retireMaterializedViews();
  }

  retireMaterializedViews(): void {
    this.#generation += 1;
    this.#materialized.clear();
  }

  reset(): void {
    this.#live.clear();
    this.retireMaterializedViews();
    this.#truncated = false;
  }

  ingestToolEvent(payload: Record<string, unknown>): void {
    const data = record(payload.data) ?? payload;
    const toolCallId =
      text(data.toolCallId) ?? text(data.tool_call_id) ?? text(data.id) ?? "unknown";
    const toolName = text(data.name) ?? text(data.toolName);
    this.#ingest(
      collectToolEventUiArtifacts(
        data,
        {
          sessionKey: this.#options.sessionKey,
          matchesSessionKey: (key) => this.#options.matchesSessionKey(key),
          toolCallId,
          ...(toolName ? { toolName } : {}),
          live: true,
        },
        this.#bounds(),
      ),
    );
  }

  snapshot(entries: SessionProjectionState["entries"]): UiArtifact[] {
    const bounds = this.#bounds();
    const candidateBounds = { ...bounds, maxArtifacts: bounds.maxArtifacts + 1 };
    let historyCandidates: UiArtifact[] = [];
    for (const entry of entries) {
      if (!entry) {
        continue;
      }
      if (
        entry.message !== null &&
        typeof entry.message === "object" &&
        this.#retiredMessages.has(entry.message)
      ) {
        continue;
      }
      const incoming = collectMessageUiArtifacts(
        entry.message,
        {
          sessionKey: this.#options.sessionKey,
          matchesSessionKey: (key) => this.#options.matchesSessionKey(key),
          ...(entry.identity?.id ? { messageId: entry.identity.id } : {}),
          ...(entry.identity?.sequence !== null && entry.identity?.sequence !== undefined
            ? { messageSequence: entry.identity.sequence }
            : {}),
          live: entry.live,
        },
        bounds,
        bounds.maxArtifacts + 1,
      );
      historyCandidates = reconcileUiArtifacts(
        [...historyCandidates, ...incoming],
        candidateBounds,
      );
    }
    const candidates = [...historyCandidates];
    for (const live of this.#live.values()) {
      const historyIndex = candidates.findIndex((artifact) => artifact.id === live.id);
      if (historyIndex < 0) {
        candidates.push(live);
        continue;
      }
      const history = candidates[historyIndex];
      if (!history) {
        continue;
      }
      const [merged] = reconcileUiArtifacts([history, live], { ...bounds, maxArtifacts: 2 });
      if (!merged) {
        continue;
      }
      candidates[historyIndex] = merged;
      if (live.revision > history.revision) {
        candidates.splice(historyIndex, 1);
        candidates.push(merged);
      }
    }
    if (
      historyCandidates.length > bounds.maxArtifacts ||
      new Set(candidates.map((artifact) => artifact.id)).size > bounds.maxArtifacts
    ) {
      this.#truncated = true;
    }
    const artifacts = applyMaterializedUiArtifactViews(
      reconcileUiArtifacts(candidates, bounds),
      this.#materialized,
    );
    const retainedKeys = new Set(
      artifacts.flatMap((artifact) =>
        artifact.views.map((view) => materializedViewKey(artifact.id, artifact.revision, view.id)),
      ),
    );
    for (const key of this.#materialized.keys()) {
      if (!retainedKeys.has(key)) {
        this.#materialized.delete(key);
      }
    }
    return artifacts;
  }

  async materialize(
    input: ControlModelMaterializeViewInput,
    options?: ControlModelRequestOptions,
  ): Promise<ControlModelMaterializedView> {
    this.#options.assertCommandReady("artifact.materialize");
    const artifactId = text(input.artifactId);
    const artifactRevision = safeInteger(input.artifactRevision);
    const viewId = text(input.viewId);
    if (!artifactId || artifactRevision === null || artifactRevision < 0 || !viewId) {
      throw localError(
        "invalid-input",
        "artifact.materialize",
        "Artifact id, revision, and view id are required",
        "INVALID_ARTIFACT_VIEW_INPUT",
      );
    }
    const artifact = this.#options
      .getCurrentArtifacts()
      .find((candidate) => candidate.id === artifactId);
    if (!artifact) {
      throw localError(
        "not-found",
        "artifact.materialize",
        "UI artifact was not found",
        "ARTIFACT_NOT_FOUND",
      );
    }
    if (artifact.revision !== artifactRevision) {
      throw localError(
        "stale",
        "artifact.materialize",
        "UI artifact revision is stale",
        "STALE_ARTIFACT_REVISION",
      );
    }
    if (artifact.state === "failed" || artifact.state === "expired") {
      throw localError(
        "conflict",
        "artifact.materialize",
        "UI artifact is not materializable",
        "ARTIFACT_NOT_MATERIALIZABLE",
      );
    }
    const view = artifact.views.find((candidate) => candidate.id === viewId);
    if (!view) {
      throw localError(
        "not-found",
        "artifact.materialize",
        "UI artifact view was not found",
        "ARTIFACT_VIEW_NOT_FOUND",
      );
    }
    if (view.availability === "inline") {
      return cloneAndFreeze(view);
    }
    const materialize = this.#options.host.gateway.materializeArtifactView;
    if (!materialize) {
      throw localError(
        "unsupported",
        "artifact.materialize",
        "Deferred UI artifact materialization is unsupported",
        "ARTIFACT_MATERIALIZATION_UNSUPPORTED",
      );
    }

    this.#activeOperations += 1;
    let epoch: number | null = null;
    const generation = this.#generation;
    try {
      epoch = this.#options.captureEpoch("artifact.materialize");
      const result = record(
        await materialize(
          {
            sessionKey: this.#options.sessionKey,
            ...(this.#options.host.agentId ? { agentId: this.#options.host.agentId } : {}),
            artifactId,
            artifactRevision,
            viewId,
          },
          options,
        ),
      );
      this.#options.assertEpoch(epoch, "artifact.materialize");
      if (generation !== this.#generation) {
        throw localError(
          "stale",
          "artifact.materialize",
          "UI artifact lifecycle changed while materializing",
          "STALE_ARTIFACT_VIEW",
        );
      }
      const current = this.#options
        .getCurrentArtifacts()
        .find((candidate) => candidate.id === artifactId);
      const currentView = current?.views.find((candidate) => candidate.id === viewId);
      if (
        !current ||
        current.revision !== artifactRevision ||
        current.state !== artifact.state ||
        !currentView ||
        currentView.availability !== "deferred" ||
        stableStringify(currentView) !== stableStringify(view)
      ) {
        throw localError(
          "stale",
          "artifact.materialize",
          "UI artifact or selected view changed while materializing",
          "STALE_ARTIFACT_VIEW",
        );
      }
      if (
        text(result?.artifactId) !== artifactId ||
        safeInteger(result?.artifactRevision) !== artifactRevision
      ) {
        throw localError(
          "malformed",
          "artifact.materialize",
          "Materialized UI artifact identity does not match the request",
          "MALFORMED_ARTIFACT_MATERIALIZATION",
        );
      }
      const normalized = normalizeUiArtifact(
        {
          version: 1,
          id: artifactId,
          revision: artifactRevision,
          views: [result?.view],
          state: "ready",
          source: current.source,
        },
        this.#bounds(),
      );
      const normalizedView = normalized.ok ? normalized.value.views[0] : undefined;
      if (
        !normalizedView ||
        normalizedView.id !== viewId ||
        normalizedView.templateUri !== view.templateUri ||
        normalizedView.dataVersion !== view.dataVersion ||
        normalizedView.availability !== "inline"
      ) {
        throw localError(
          "malformed",
          "artifact.materialize",
          "Materialized UI artifact view is malformed or incompatible",
          "MALFORMED_ARTIFACT_MATERIALIZATION",
        );
      }
      const materializedView = {
        ...normalizedView,
        ...(view.recommended === true ? { recommended: true } : {}),
        ...(view.fallback && !normalizedView.fallback ? { fallback: view.fallback } : {}),
      };
      const key = materializedViewKey(artifactId, artifactRevision, viewId);
      const candidateMaterialized = new Map(this.#materialized).set(key, materializedView);
      const normalizedCurrent = normalizeUiArtifact(current, this.#bounds());
      const combined = normalizedCurrent.ok
        ? applyMaterializedUiArtifactViews([normalizedCurrent.value], candidateMaterialized)[0]
        : undefined;
      const normalizedCombined = combined
        ? normalizeUiArtifact(combined, this.#bounds())
        : undefined;
      const retainedView = normalizedCombined?.ok
        ? normalizedCombined.value.views.find((candidate) => candidate.id === viewId)
        : undefined;
      if (!retainedView || retainedView.availability !== "inline") {
        throw localError(
          "malformed",
          "artifact.materialize",
          "Materialized UI artifact exceeds the configured bounds",
          "ARTIFACT_MATERIALIZATION_EXCEEDS_BOUNDS",
        );
      }
      this.#materialized.set(key, retainedView);
      this.#options.publish();
      return cloneAndFreeze(retainedView);
    } catch (error) {
      if (error instanceof ControlModelCommandError) {
        throw error;
      }
      throw this.#options.normalizeCommandError(error, "artifact.materialize", epoch);
    } finally {
      this.#activeOperations -= 1;
    }
  }

  #bounds(): ControlModelArtifactProjectionBounds {
    const bounds = this.#options.host.bounds;
    return {
      maxArtifacts: bounds.maxArtifacts,
      maxBytes: bounds.maxArtifactBytes,
      maxDepth: bounds.maxArtifactDepth,
      maxCollectionItems: bounds.maxArtifactCollectionItems,
      maxStringBytes: bounds.maxArtifactStringBytes,
      maxViews: bounds.maxArtifactViews,
    };
  }

  #ingest(incoming: readonly UiArtifact[]): void {
    if (incoming.length === 0) {
      return;
    }
    if (
      new Set([...this.#live.values(), ...incoming].map((artifact) => artifact.id)).size >
      this.#options.host.bounds.maxArtifacts
    ) {
      this.#truncated = true;
    }
    const retained = reconcileUiArtifacts([...this.#live.values(), ...incoming], this.#bounds());
    this.#live.clear();
    for (const artifact of retained) {
      this.#live.set(artifact.id, artifact);
    }
  }
}
