import { ReefAutonomySchema } from "./friend-types.js";
import { getActiveReef } from "./runtime.js";

export async function handleReefCommand({ args }: { args?: string }): Promise<{ text: string }> {
  const active = getActiveReef();
  const words = (args ?? "").trim().split(/\s+/).filter(Boolean);
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
    const found = await active.reviews.decide(words[2], words[1] === "approve");
    return {
      text: found
        ? `Reef review ${words[1]}d. Retry the identical message to re-run the guard.`
        : "Unknown Reef approval digest.",
    };
  }
  return {
    text: "Usage: /reef friend code|request <handle> [code]|list|remove <handle>|autonomy <handle> <notify-only|bounded|extended>; /reef review list|approve <digest>|deny <digest>",
  };
}
