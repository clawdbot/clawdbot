import { fingerprint } from "../protocol/index.js";
import { normalizeReefTarget } from "./config-schema.js";
import type { ReefAutonomy, ReefPeerTrust } from "./friend-types.js";
import type { ReefTransportClient } from "./transport.js";
import { ReefRelayError } from "./transport.js";
import type { ReefTrustStore } from "./trust-store.js";
import type { RelayFriend } from "./types.js";

type PairingChallenge = (params: {
  peer: string;
  fingerprint: string;
  code: string;
  approvalToken: string;
}) => Promise<void>;

type ReefPairingApprovals = {
  list(): Promise<string[]>;
  remove(peer: string): Promise<boolean>;
};

type ListedReefFriend = RelayFriend & {
  fingerprint: string;
  autonomy?: ReefAutonomy;
};

type ReefPairingApproval = {
  entry: string;
  trustRevision: number;
};

function keysChanged(local: ReefPeerTrust, remote: RelayFriend): boolean {
  return (
    local.keyEpoch !== remote.key_epoch ||
    local.ed25519PublicKey !== remote.ed25519_pub ||
    local.x25519PublicKey !== remote.x25519_pub
  );
}

export class ReefFriendManager {
  #mutations: Promise<void> = Promise.resolve();

  constructor(
    readonly transport: ReefTransportClient,
    readonly trust: ReefTrustStore,
    readonly pairing: ReefPairingApprovals,
  ) {}

  mintCode() {
    return this.transport.mintFriendCode();
  }

  request(peer: string, code?: string): Promise<{ status: string }> {
    return this.#serialize(async () => {
      const normalized = normalizeReefTarget(peer);
      if (!normalized) {
        throw new Error(`Invalid Reef peer handle: ${peer}`);
      }
      // Persist owner intent before the relay side effect. Once the peer
      // accepts, this marker authorizes pinning without a second approval.
      const requestId = this.trust.recordOutboundRequest(normalized);
      let result: { status: string };
      try {
        result = await this.transport.requestFriend(normalized, code);
      } catch (error) {
        const definitiveRejection =
          error instanceof ReefRelayError &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 409;
        if (definitiveRejection) {
          this.trust.removeOutboundRequest(normalized, requestId);
        } else if (this.trust.outboundRequestStatus(normalized, requestId) === "revoked") {
          try {
            await this.transport.removeFriend(normalized);
          } catch (cleanupError) {
            const failure = new AggregateError(
              [error, cleanupError],
              `Reef friend request to @${normalized} failed after concurrent revocation`,
              { cause: cleanupError },
            );
            throw failure;
          }
        }
        throw error;
      }
      if (this.trust.outboundRequestStatus(normalized, requestId) === "revoked") {
        await this.transport.removeFriend(normalized);
        throw new Error(`Reef friend request to @${normalized} was concurrently revoked`);
      }
      return result;
    });
  }

  remove(peer: string): Promise<void> {
    return this.#serialize(async () => {
      const normalized = normalizeReefTarget(peer);
      if (!normalized) {
        throw new Error(`Invalid Reef peer handle: ${peer}`);
      }
      // Local revocation remains fail-closed even when the relay is offline.
      this.trust.remove(normalized);
      const results = await Promise.allSettled([
        this.#removePairingApprovalsForPeer(normalized),
        this.#removeRelayAndRefence(normalized),
      ]);
      const failures = results.flatMap((result) =>
        result.status === "rejected"
          ? [
              result.reason instanceof Error
                ? result.reason
                : new Error("Reef friendship removal failed", { cause: result.reason }),
            ]
          : [],
      );
      if (failures.length === 1) {
        throw failures[0]!;
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "Reef friendship removal failed");
      }
    });
  }

  setAutonomy(peer: string, autonomy: ReefAutonomy): Promise<void> {
    return this.#serialize(() => {
      this.trust.setAutonomy(peer, autonomy);
    });
  }

  async list(): Promise<ListedReefFriend[]> {
    const local = new Map(this.trust.list().map((entry) => [entry.peer, entry.trust]));
    const { friendships } = await this.transport.listFriends();
    const listed: ListedReefFriend[] = [];
    for (const friend of friendships) {
      const autonomy = local.get(friend.peer)?.autonomy;
      listed.push({
        ...friend,
        fingerprint: fingerprint(friend.ed25519_pub, friend.x25519_pub),
        ...(autonomy ? { autonomy } : {}),
      });
    }
    return listed;
  }

  surfacePairingCandidates(issue: PairingChallenge): Promise<void> {
    return this.#serialize(async () => {
      const { friendships } = await this.transport.listFriends();
      const approvals = await this.#loadPairingApprovals(friendships);

      for (const friend of friendships) {
        if (friend.status === "blocked") {
          continue;
        }
        const snapshot = this.trust.snapshot(friend.peer);
        const approval = approvals.get(friend.peer);
        if (approval?.trustRevision === snapshot.revision) {
          continue;
        }
        if (approval) {
          await this.pairing.remove(approval.entry);
        }
        const local = snapshot.trust;
        const changed = local ? keysChanged(local, friend) : false;
        const inboundPending =
          friend.status === "pending" && friend.initiated_by !== this.transport.handle;
        const missingLocalApproval =
          (friend.status === "active" || friend.status === "reapprove_required") &&
          !local &&
          Object.keys(snapshot.outboundRequests ?? {}).length === 0;
        const needsReapproval =
          friend.status === "reapprove_required" ||
          (friend.status === "active" && Boolean(local && (changed || local.safetyNumberChanged)));
        if (!inboundPending && !missingLocalApproval && !needsReapproval) {
          continue;
        }
        await issue({
          peer: friend.peer,
          fingerprint: fingerprint(friend.ed25519_pub, friend.x25519_pub),
          code: friend.peer,
          approvalToken: this.trust.createPairingApproval(friend, snapshot.revision),
        });
      }
    });
  }

  reconcile(): Promise<string[]> {
    return this.#serialize(async () => {
      const { friendships } = await this.transport.listFriends();
      const approvals = await this.#loadPairingApprovals(friendships);
      const changed = new Set<string>();

      for (const friend of friendships) {
        if (friend.status === "blocked") {
          continue;
        }
        const snapshot = this.trust.snapshot(friend.peer);
        const local = snapshot.trust;
        const loadedApproval = approvals.get(friend.peer);
        const approval =
          loadedApproval?.trustRevision === snapshot.revision ? loadedApproval : undefined;
        if (loadedApproval && !approval) {
          await this.pairing.remove(loadedApproval.entry);
        }
        const approvalEntry = approval?.entry;
        const approved = approval !== undefined;
        const outboundRequestId = Object.keys(snapshot.outboundRequests ?? {}).toSorted()[0];
        const changedKeys = local ? keysChanged(local, friend) : false;

        if (changedKeys && local && !approved) {
          if (
            !local.safetyNumberChanged &&
            this.trust.markSafetyNumberChanged(friend.peer, snapshot.revision)
          ) {
            changed.add(friend.peer);
          }
          continue;
        }

        const selfInitiated =
          friend.status === "active" && !local && outboundRequestId !== undefined;
        const needsPin =
          selfInitiated ||
          (approved &&
            (!local ||
              changedKeys ||
              local.safetyNumberChanged ||
              friend.status === "pending" ||
              friend.status === "reapprove_required"));

        if (!needsPin) {
          if (friend.status === "active" && local && outboundRequestId !== undefined) {
            this.trust.removeOutboundRequest(friend.peer);
          }
          if (approvalEntry !== undefined && local && !changedKeys && !local.safetyNumberChanged) {
            await this.pairing.remove(approvalEntry);
          }
          continue;
        }

        if (friend.status === "pending" || friend.status === "reapprove_required") {
          if (!approved) {
            continue;
          }
        } else if (friend.status !== "active") {
          continue;
        }

        // Consume the one-shot approval before any relay or trust mutation.
        // A later failure safely requires fresh owner approval instead of
        // leaving a handoff that could authorize different relay keys.
        if (approvalEntry && !(await this.pairing.remove(approvalEntry))) {
          continue;
        }

        if (friend.status === "pending" || friend.status === "reapprove_required") {
          await this.transport.respondFriend(friend, true);
        }

        const committed = this.trust.commitPeerTrust(friend, {
          expectedRevision: snapshot.revision,
          ...(selfInitiated && outboundRequestId !== undefined
            ? { expectedOutboundRequestId: outboundRequestId }
            : {}),
        });
        if (committed) {
          changed.add(friend.peer);
          continue;
        }

        const current = this.trust.snapshot(friend.peer);
        if (
          current.revision > snapshot.revision &&
          !current.trust &&
          Object.keys(current.outboundRequests ?? {}).length === 0
        ) {
          // A concurrent local removal won after relay acceptance. Delete the
          // stale edge again so the older accept cannot restore reachability.
          await this.transport.removeFriend(friend.peer);
        }
      }

      return [...changed].toSorted();
    });
  }

  async #loadPairingApprovals(
    friendships: RelayFriend[],
  ): Promise<Map<string, ReefPairingApproval>> {
    const relayPeers = new Map(friendships.map((friend) => [friend.peer, friend]));
    const approvals = new Map<string, ReefPairingApproval>();
    for (const entry of await this.pairing.list()) {
      const parsed = this.trust.parsePairingApproval(entry);
      if (!parsed) {
        await this.pairing.remove(entry);
        continue;
      }
      const remote = relayPeers.get(parsed.peer);
      if (
        !remote ||
        remote.status === "blocked" ||
        !this.trust.matchesPairingApproval(entry, remote)
      ) {
        await this.pairing.remove(entry);
        continue;
      }
      approvals.set(parsed.peer, { entry, trustRevision: parsed.trustRevision });
    }
    return approvals;
  }

  async #removePairingApprovalsForPeer(peer: string): Promise<void> {
    for (const entry of await this.pairing.list()) {
      const parsed = this.trust.parsePairingApproval(entry);
      if (parsed?.peer === peer || normalizeReefTarget(entry) === peer) {
        await this.pairing.remove(entry);
      }
    }
  }

  async #removeRelayAndRefence(peer: string): Promise<void> {
    await this.transport.removeFriend(peer);
    // The relay delete linearizes removal. Reapply the tombstone afterwards so
    // a request or pin committed while DELETE was in flight cannot outlive it.
    this.trust.remove(peer);
  }

  #serialize<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.#mutations.then(operation);
    this.#mutations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
