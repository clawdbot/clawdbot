import type { ReefFederationFrame } from "../protocol/federation.js";
import type { ReefFederationPromptRequest, ReefFederationState } from "./federation-state.js";
import { sameReefPeerIdentity, type ReefPeerIdentity } from "./friend-types.js";

/** Return whether a recovered outcome still belongs to the peer's exact trusted identity. */
export function matchesFederatedPromptPeer(
  request: ReefFederationPromptRequest,
  currentIdentity: ReefPeerIdentity | undefined,
): boolean {
  return Boolean(currentIdentity && sameReefPeerIdentity(currentIdentity, request.peerIdentity));
}

/** Re-submit every durable terminal outcome that is not already running. */
export function retryUnsentFederatedPrompts(
  federation: Pick<ReefFederationState, "listUnsentProposals">,
  start: (
    request: ReefFederationPromptRequest,
    outcome?: Exclude<
      ReefFederationFrame,
      { type: "session.mount.offer" | "session.prompt.propose" }
    >,
  ) => void | Promise<void>,
): void {
  for (const proposal of federation.listUnsentProposals()) {
    void start(proposal.request, proposal.outcome);
  }
}

/** Re-send every durably revoked issuer grant; holder application is generation-idempotent. */
export async function retryFederatedRevocations(
  federation: Pick<ReefFederationState, "listMounts" | "acknowledgeRevocation">,
  send: (
    peer: string,
    frame: ReefFederationFrame,
    peerIdentity: ReefPeerIdentity,
  ) => Promise<unknown>,
  onError: (error: unknown, peer: string) => void = () => undefined,
): Promise<void> {
  for (const mount of federation.listMounts()) {
    if (mount.role !== "host" || !mount.revoked || !mount.revocationPending) {
      continue;
    }
    try {
      await send(
        mount.peer,
        {
          type: "session.grant.revoked",
          mountId: mount.mountId,
          sessionId: mount.sessionId,
          grantGeneration: mount.grantGeneration,
        },
        mount.peerIdentity,
      );
      if (!federation.acknowledgeRevocation(mount.mountId, mount.grantGeneration)) {
        throw new Error(`Reef mount ${mount.mountId} lost its durable revocation`);
      }
    } catch (error) {
      onError(error, mount.peer);
    }
  }
}
