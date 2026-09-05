import { prepareReefMessageId } from "./flow.js";
import { reefPeerIdentity, ReefAutonomySchema, sameReefPeerIdentity } from "./friend-types.js";
import { getActiveReef, getReefRuntime } from "./runtime.js";

export async function handleReefCommand({
  args,
  senderIsOwner,
}: {
  args?: string;
  senderIsOwner?: boolean;
}): Promise<{ text: string }> {
  const words = (args ?? "").trim().split(/\s+/).filter(Boolean);
  const changesFriendship =
    words[0] === "friend" && /^(code|request|remove|block|autonomy)$/.test(words[1] ?? "");
  const decidesReview = words[0] === "review" && /^(approve|deny)$/.test(words[1] ?? "");
  const changesSession = words[0] === "session";
  if ((changesFriendship || decidesReview || changesSession) && senderIsOwner !== true) {
    return {
      text: "Only an owner in commands.ownerAllowFrom can change Reef friends, decide reviews, or share, prompt, and revoke session mounts. Ask a configured owner; friendship changes can also use openclaw reef locally.",
    };
  }
  const active = getActiveReef();
  if (words[0] === "friend" && words[1] === "code") {
    const minted = await active.friends.mintCode();
    return {
      text: `Reef friend code: ${minted.code} (expires ${new Date(minted.expires * 1000).toISOString()})`,
    };
  }
  if (words[0] === "friend" && words[1] === "request" && words[2]) {
    await active.friends.request(words[2].replace(/^@/, "").toLowerCase(), words[3]);
    return { text: "Reef friend request submitted." };
  }
  if (words[0] === "friend" && words[1] === "list") {
    const friends = await active.friends.list();
    return {
      text: friends.length
        ? friends
            .map(
              (friend) =>
                `@${friend.peer} ${friend.status} epoch=${friend.key_epoch} fingerprint=${friend.fingerprint} autonomy=${friend.autonomy ?? "unapproved"}`,
            )
            .join("\n")
        : "No Reef friends.",
    };
  }
  if (words[0] === "friend" && /^(remove|block)$/.test(words[1] ?? "") && words[2]) {
    const peer = words[2].replace(/^@/, "").toLowerCase();
    await active.friends.remove(peer);
    return { text: `Reef friend @${peer} blocked and removed locally.` };
  }
  if (words[0] === "friend" && words[1] === "autonomy" && words[2] && words[3]) {
    const peer = words[2].replace(/^@/, "").toLowerCase();
    const autonomy = ReefAutonomySchema.parse(words[3]);
    await active.friends.setAutonomy(peer, autonomy);
    return { text: `Reef friend @${peer} autonomy set to ${autonomy}.` };
  }
  if (words[0] === "session" && words[1] === "share" && words[2] && words[3]) {
    const peer = words[2].replace(/^@/, "").toLowerCase();
    const sessionKey = words[3];
    const friend = active.trust.get(peer);
    if (!friend || friend.safetyNumberChanged) {
      return { text: `Reef peer @${peer} is not approved with current keys.` };
    }
    const result = await getReefRuntime().gateway.request<{
      sessions?: Array<{ key?: string; sessionId?: string }>;
    }>("sessions.list", { search: sessionKey, limit: 20 });
    const session = result.sessions?.find((entry) => entry.key === sessionKey);
    if (!session?.sessionId) {
      return { text: `Session ${sessionKey} was not found.` };
    }
    const peerIdentity = reefPeerIdentity(friend);
    const existing = active.federation.listMounts().find(
      (mount) =>
        mount.role === "host" &&
        !mount.revoked &&
        mount.peer === peer &&
        mount.sessionKey === sessionKey &&
        mount.sessionId === session.sessionId &&
        sameReefPeerIdentity(mount.peerIdentity, peerIdentity) &&
        active.federation.authorizeMount({
          mountId: mount.mountId,
          peer,
          peerIdentity,
          sessionId: mount.sessionId,
          generation: mount.grantGeneration,
        }) !== undefined,
    );
    const mount = existing ?? {
      mountId: `reef-mount-${prepareReefMessageId()}`,
      peer,
      peerIdentity,
      role: "host" as const,
      sessionKey,
      sessionId: session.sessionId,
      grantGeneration: 0,
      allowAlways: false,
      revoked: false,
    };
    if (!existing && !active.federation.createMount(mount)) {
      return {
        text: `Could not create a Reef session mount for @${peer}; retry after older mounts expire.`,
      };
    }
    await active.flow.sendFederation(
      peer,
      {
        type: "session.mount.offer",
        mountId: mount.mountId,
        sessionKey,
        sessionId: session.sessionId,
        grantGeneration: 0,
      },
      { expectedRecipient: peerIdentity },
    );
    return { text: `Shared ${sessionKey} with @${peer} as mount ${mount.mountId}.` };
  }
  if (words[0] === "session" && words[1] === "prompt" && words[2] && words[3]) {
    const mount = active.federation.getMount(words[2]);
    if (!mount || mount.role !== "guest" || mount.revoked) {
      return { text: `Unknown active guest Reef session mount ${words[2]}.` };
    }
    const proposalId = await active.flow.proposeFederatedPrompt(
      mount,
      words.slice(3).join(" "),
      active.federation,
    );
    return { text: `Sent Reef prompt proposal ${proposalId}.` };
  }
  if (words[0] === "session" && words[1] === "revoke" && words[2]) {
    const mount = active.federation.getMount(words[2]);
    if (!mount || mount.role !== "host") {
      return { text: `Unknown host Reef session mount ${words[2]}.` };
    }
    const revoked = active.federation.revoke(mount.mountId, mount.grantGeneration);
    if (!revoked) {
      return { text: `Reef session mount ${mount.mountId} changed before revocation.` };
    }
    await active.flow.sendFederation(
      mount.peer,
      {
        type: "session.grant.revoked",
        mountId: mount.mountId,
        sessionId: mount.sessionId,
        grantGeneration: revoked.grantGeneration,
      },
      { expectedRecipient: mount.peerIdentity },
    );
    if (
      revoked.revocationPending &&
      !active.federation.acknowledgeRevocation(mount.mountId, revoked.grantGeneration)
    ) {
      throw new Error(`Reef session mount ${mount.mountId} lost its durable revocation`);
    }
    return { text: `Revoked Reef session mount ${mount.mountId}.` };
  }
  if (words[0] === "session" && words[1] === "list") {
    const mounts = active.federation.listMounts();
    return {
      text: mounts.length
        ? mounts
            .map(
              (mount) =>
                `${mount.mountId} ${mount.role} @${mount.peer} ${mount.sessionKey} generation=${mount.grantGeneration}${mount.revoked ? " revoked" : mount.allowAlways ? " allow-always" : " ask"}`,
            )
            .join("\n")
        : "No Reef session mounts.",
    };
  }
  if (words[0] === "review" && words[1] === "list") {
    const reviews = await active.reviews.list();
    return {
      text: reviews.length
        ? reviews
            .map(
              (review) =>
                `${review.approvalDigest} ${review.direction} ${review.from} -> ${review.to} ${review.verdict.category}`,
            )
            .join("\n")
        : "No pending Reef reviews.",
    };
  }
  if (words[0] === "review" && /^(approve|deny)$/.test(words[1] ?? "") && words[2]) {
    const decided = await active.reviews.decide(words[2], words[1] === "approve");
    if (!decided) {
      return { text: "Unknown Reef approval digest." };
    }
    return {
      text:
        decided.direction === "inbound"
          ? `Reef review ${words[1]}d. The parked message from ${decided.from} is re-processed from the relay within about 30 seconds.`
          : `Reef review ${words[1]}d. Retry the identical message to re-run the guard.`,
    };
  }
  return {
    text: "Usage: /reef friend code|request <handle> [code]|list|remove <handle>|autonomy <handle> <notify-only|bounded|extended>; /reef review list|approve <digest>|deny <digest>; /reef session share <handle> <session-key>|list|prompt <mount-id> <text>|revoke <mount-id>",
  };
}
