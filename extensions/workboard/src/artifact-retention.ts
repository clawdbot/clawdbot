import path from "node:path";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  canonicalPathFromExistingAncestor,
  isPathInside,
} from "openclaw/plugin-sdk/security-runtime";
import {
  isWorkboardCardStore,
  type PersistedWorkboardCard,
  type WorkboardCardStore,
  type WorkboardKeyedStore,
} from "./persistence-types.js";

const ARTIFACT_RETENTION_CLAIM_ID = "persisted-local-artifacts";

type WorktreeRetentionRuntime = Pick<PluginRuntime["worktrees"], "setRetentionClaim">;

export type WorkboardArtifactRetentionStore = WorkboardKeyedStore & {
  reconcileArtifactRetention(): Promise<void>;
};

function worktreeWorkspacePath(card: WorkboardCard | undefined): string | undefined {
  const workspace = card?.metadata?.automation?.workspace;
  return workspace?.kind === "worktree" && workspace.path ? workspace.path : undefined;
}

async function retainedWorkspacePath(card: WorkboardCard | undefined): Promise<string | undefined> {
  const workspacePath = worktreeWorkspacePath(card);
  if (!card || card.metadata?.archivedAt || !workspacePath) {
    return undefined;
  }
  const artifactPaths = (card.metadata?.artifacts ?? []).flatMap((artifact) =>
    artifact.path ? [artifact.path] : [],
  );
  if (artifactPaths.length === 0) {
    return undefined;
  }
  const workspaceRoot = path.resolve(workspacePath);
  try {
    const canonicalWorkspaceRoot = await canonicalPathFromExistingAncestor(workspaceRoot);
    for (const artifact of artifactPaths) {
      const artifactPath = path.resolve(workspaceRoot, artifact);
      const canonicalArtifactPath = await canonicalPathFromExistingAncestor(artifactPath);
      if (isPathInside(canonicalWorkspaceRoot, canonicalArtifactPath)) {
        return workspacePath;
      }
    }
  } catch {
    // A path-resolution failure must not turn persisted local state into an unprotected tree.
    return workspacePath;
  }
  return undefined;
}

async function setArtifactRetentionClaim(params: {
  worktrees: WorktreeRetentionRuntime;
  card: WorkboardCard;
  workspacePath: string;
  active: boolean;
  allowUnavailable?: boolean;
}): Promise<void> {
  const accepted = await params.worktrees.setRetentionClaim({
    path: params.workspacePath,
    ownerKind: "workboard",
    ownerId: params.card.id,
    claimId: ARTIFACT_RETENTION_CLAIM_ID,
    active: params.active,
  });
  if (params.active && !accepted && !params.allowUnavailable) {
    throw new Error(
      `managed worktree is unavailable for artifact retention: ${params.workspacePath}`,
    );
  }
}

export function withWorkboardArtifactRetention(
  store: WorkboardKeyedStore,
  worktrees: WorktreeRetentionRuntime,
): WorkboardArtifactRetentionStore {
  let reconciliation: Promise<void> | undefined;
  const pendingReleases = new Map<string, { card: WorkboardCard; workspacePath: string }>();
  const releaseClaim = async (card: WorkboardCard, workspacePath: string): Promise<void> => {
    const key = `${card.id}\0${workspacePath}`;
    try {
      await setArtifactRetentionClaim({
        worktrees,
        card,
        workspacePath,
        active: false,
      });
      pendingReleases.delete(key);
    } catch (error) {
      pendingReleases.set(key, { card, workspacePath });
      reconciliation = undefined;
      throw error;
    }
  };
  const reconcileArtifactRetention = () => {
    reconciliation ??= (async () => {
      for (const { card, workspacePath } of pendingReleases.values()) {
        await releaseClaim(card, workspacePath);
      }
      for (const entry of await store.entries()) {
        const card = entry.value?.version === 1 ? entry.value.card : undefined;
        const workspacePath = worktreeWorkspacePath(card);
        if (!card || !workspacePath) {
          continue;
        }
        const active = Boolean(await retainedWorkspacePath(card));
        if (active) {
          await setArtifactRetentionClaim({
            worktrees,
            card,
            workspacePath,
            active: true,
            // Pre-retention cards can outlive worktrees that old cleanup already removed.
            allowUnavailable: true,
          });
        } else {
          await releaseClaim(card, workspacePath);
        }
      }
    })().catch((error: unknown) => {
      reconciliation = undefined;
      throw error;
    });
    return reconciliation;
  };

  type CardTransition = {
    nextCard: WorkboardCard;
    nextPath?: string;
    previousCard?: WorkboardCard;
    previousPath?: string;
  };

  const prepareCardTransition = async (
    key: string,
    value: PersistedWorkboardCard,
  ): Promise<CardTransition> => {
    await reconcileArtifactRetention();
    const previous = await store.lookup(key);
    const previousCard = previous?.version === 1 ? previous.card : undefined;
    const nextPath = await retainedWorkspacePath(value.card);
    const previousPath = await retainedWorkspacePath(previousCard);
    if (nextPath) {
      await setArtifactRetentionClaim({
        worktrees,
        card: value.card,
        workspacePath: nextPath,
        active: true,
      });
    }
    return { nextCard: value.card, nextPath, previousCard, previousPath };
  };

  const settleCardTransition = async (
    transition: CardTransition,
    applied: boolean,
  ): Promise<void> => {
    if (!applied) {
      if (transition.nextPath && transition.nextPath !== transition.previousPath) {
        await releaseClaim(transition.nextCard, transition.nextPath).catch(() => undefined);
      }
      return;
    }
    if (
      transition.previousCard &&
      transition.previousPath &&
      transition.previousPath !== transition.nextPath
    ) {
      await releaseClaim(transition.previousCard, transition.previousPath);
    }
  };

  const updateWithRetention = async <T>(
    key: string,
    value: PersistedWorkboardCard,
    update: () => Promise<T>,
    wasApplied: (result: T) => boolean,
  ): Promise<T> => {
    const transition = await prepareCardTransition(key, value);
    let result: T;
    try {
      result = await update();
    } catch (error) {
      await settleCardTransition(transition, false);
      throw error;
    }
    await settleCardTransition(transition, wasApplied(result));
    return result;
  };

  const deleteWithRetention = async (
    key: string,
    remove: () => Promise<boolean>,
  ): Promise<boolean> => {
    await reconcileArtifactRetention();
    const previous = await store.lookup(key);
    const previousCard = previous?.version === 1 ? previous.card : undefined;
    const previousPath = await retainedWorkspacePath(previousCard);
    const deleted = await remove();
    if (deleted && previousCard && previousPath) {
      await releaseClaim(previousCard, previousPath);
    }
    return deleted;
  };

  const decorated: WorkboardArtifactRetentionStore = {
    reconcileArtifactRetention,
    async register(key, value) {
      await updateWithRetention(
        key,
        value,
        async () => await store.register(key, value),
        () => true,
      );
    },
    async lookup(key) {
      await reconcileArtifactRetention();
      return await store.lookup(key);
    },
    async delete(key) {
      return await deleteWithRetention(key, async () => await store.delete(key));
    },
    async entries() {
      await reconcileArtifactRetention();
      return await store.entries();
    },
  };

  if (!isWorkboardCardStore(store)) {
    return decorated;
  }
  const cardStore: WorkboardCardStore = store;
  return {
    ...decorated,
    async registerIfAbsent(key, value) {
      return await updateWithRetention(
        key,
        value,
        async () => await cardStore.registerIfAbsent(key, value),
        (applied) => applied,
      );
    },
    async registerIfUpdatedAt(key, value, expectedUpdatedAt) {
      return await updateWithRetention(
        key,
        value,
        async () => await cardStore.registerIfUpdatedAt(key, value, expectedUpdatedAt),
        (applied) => applied,
      );
    },
    async claimIfOwnerAvailable(key, value, expectedUpdatedAt, ownerId, now) {
      return await updateWithRetention(
        key,
        value,
        async () =>
          await cardStore.claimIfOwnerAvailable(key, value, expectedUpdatedAt, ownerId, now),
        (result) => result === "updated",
      );
    },
    async deleteIfUpdatedAt(key, expectedUpdatedAt) {
      return await deleteWithRetention(
        key,
        async () => await cardStore.deleteIfUpdatedAt(key, expectedUpdatedAt),
      );
    },
    async listBoardAggregates() {
      return await cardStore.listBoardAggregates();
    },
  } as WorkboardArtifactRetentionStore & WorkboardCardStore; // SAFETY: isWorkboardCardStore proves every spread card-store method exists.
}
