import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fingerprint } from "../protocol/index.js";
import type { ReefChannelConfig, ReefFriendConfig } from "./config-schema.js";
import { writePrivateJson } from "./state.js";
import { ReefRelayError } from "./transport.js";
import type { ReefTransportClient } from "./transport.js";
import type { RelayFriend } from "./types.js";

type PairingChallenge = (params: {
  peer: string;
  fingerprint: string;
  code: string;
}) => Promise<void>;

export class ReefFriendManager {
  // Peers this claw sent a friend request to, persisted so acceptance can be
  // adopted later without treating the relay's initiator field as authorization.
  // Single shared promise so concurrent callers mutate one set, not racing copies.
  #requested: Promise<Set<string>> | undefined;

  constructor(
    readonly config: ReefChannelConfig,
    readonly transport: ReefTransportClient,
    readonly stateDir?: string,
  ) {}

  mintCode() {
    return this.transport.mintFriendCode();
  }

  // All marker mutations funnel through one queue so a slow earlier write can
  // never overwrite a newer snapshot on disk.
  #requestedWrites: Promise<void> = Promise.resolve();

  #mutateRequested(mutate: (requested: Set<string>) => boolean): Promise<void> {
    const run = this.#requestedWrites.then(async () => {
      const requested = await this.#loadRequested();
      if (mutate(requested)) {
        await this.#saveRequested(requested);
      }
    });
    // Keep the queue alive after failures; callers still observe the rejection.
    this.#requestedWrites = run.catch(() => {});
    return run;
  }

  #loadRequested(): Promise<Set<string>> {
    this.#requested ??= (async () => {
      let peers: string[] = [];
      if (this.stateDir) {
        try {
          peers = JSON.parse(
            await readFile(join(this.stateDir, "requested.json"), "utf8"),
          ) as string[];
        } catch (error) {
          // Only a missing file means "no outbound requests". Other read
          // failures must not silently replace durable authorization state.
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
          peers = [];
        }
      }
      // Marker durability is best-effort beyond this point: a lost marker is
      // fail-closed (the owner re-requests or approves via pairing), never a
      // fail-open adoption.
      return new Set(peers);
    })();
    return this.#requested;
  }

  async #saveRequested(requested: Set<string>): Promise<void> {
    if (this.stateDir) {
      await writePrivateJson(join(this.stateDir, "requested.json"), [...requested]);
    }
  }
  async request(peer: string, code?: string) {
    const normalized = peer.toLowerCase();
    // Record the owner's intent before the relay side effect: if the process
    // dies after the relay commits, the marker must already exist so a later
    // acceptance can still be adopted.
    let newlyAdded = false;
    await this.#mutateRequested((requested) => {
      if (requested.has(normalized)) {
        return false;
      }
      newlyAdded = true;
      requested.add(normalized);
      return true;
    });
    try {
      return await this.transport.requestFriend(peer, code);
    } catch (error) {
      // Roll back only the marker THIS attempt created, and only on a
      // definitive relay rejection. Ambiguous transport failures may have
      // committed remotely, and a retry's 409 must not erase the marker an
      // earlier ambiguous attempt legitimately left behind.
      const definitiveRejection =
        error instanceof ReefRelayError && error.status >= 400 && error.status < 500;
      if (newlyAdded && definitiveRejection) {
        await this.#mutateRequested((requested) => requested.delete(normalized));
      }
      throw error;
    }
  }
  async remove(peer: string) {
    delete this.config.friends[peer];
    // Cancelling also revokes the persisted outbound-request authorization so a
    // late acceptance cannot resurrect the friendship.
    await this.#mutateRequested((requested) => requested.delete(peer.toLowerCase()));
    return await this.transport.removeFriend(peer);
  }

  async list(): Promise<
    Array<RelayFriend & { fingerprint: string; autonomy?: ReefFriendConfig["autonomy"] }>
  > {
    const { friendships } = await this.transport.listFriends();
    return friendships.map((friend) => {
      const autonomy = this.config.friends[friend.peer]?.autonomy;
      const entry: RelayFriend & { fingerprint: string; autonomy?: ReefFriendConfig["autonomy"] } =
        Object.assign({}, friend, {
          fingerprint: fingerprint(friend.ed25519_pub, friend.x25519_pub),
        });
      if (autonomy) {
        entry.autonomy = autonomy;
      }
      return entry;
    });
  }

  async surfacePending(issue: PairingChallenge): Promise<void> {
    for (const friend of await this.list()) {
      if (friend.status !== "pending" && friend.status !== "reapprove_required") {
        continue;
      }
      await issue({ peer: friend.peer, fingerprint: friend.fingerprint, code: friend.peer });
    }
  }

  async reconcileApproved(approvedPeers: readonly string[]): Promise<string[]> {
    const approved = new Set(approvedPeers.map((peer) => peer.toLowerCase()));
    const requested = await this.#loadRequested();
    const changed: string[] = [];
    for (const friend of await this.list()) {
      const local = this.config.friends[friend.peer];
      if (friend.status === "active" && local && requested.has(friend.peer)) {
        // The channel's reconcile loop is strictly sequential and persists the
        // account config after every adoption before this branch can run again;
        // a crashed write restarts the channel with config reloaded from disk,
        // so observing `local` here proves the pin is durable and the
        // outbound-intent marker has served its purpose.
        await this.#mutateRequested((set) => set.delete(friend.peer));
      }
      if (
        friend.status === "active" &&
        local &&
        (local.keyEpoch !== friend.key_epoch ||
          local.ed25519PublicKey !== friend.ed25519_pub ||
          local.x25519PublicKey !== friend.x25519_pub)
      ) {
        local.safetyNumberChanged = true;
        changed.push(friend.peer);
        continue;
      }
      // Friendships this claw initiated turn active once the peer accepts; adopt
      // them without a local pairing approval (the owner already opted in by
      // sending the request). Authorization comes from the locally persisted
      // outbound request record, never from relay-supplied fields.
      const selfInitiated = friend.status === "active" && !local && requested.has(friend.peer);
      if (!approved.has(friend.peer) && !selfInitiated) {
        continue;
      }
      if (friend.status === "pending" || friend.status === "reapprove_required") {
        await this.transport.respondFriend(friend.peer, true);
      }
      this.config.friends[friend.peer] = {
        autonomy: local?.autonomy ?? "bounded",
        ed25519PublicKey: friend.ed25519_pub,
        x25519PublicKey: friend.x25519_pub,
        keyEpoch: friend.key_epoch,
        safetyNumberChanged: false,
      };
      changed.push(friend.peer);
    }
    return changed;
  }
}
