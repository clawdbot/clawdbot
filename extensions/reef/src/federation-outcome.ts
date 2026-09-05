import type { ReefFederationFrame } from "../protocol/federation.js";

export function formatReefFederationOutcome(
  peer: string,
  frame: Exclude<ReefFederationFrame, { type: "session.mount.offer" | "session.prompt.propose" }>,
): string {
  switch (frame.type) {
    case "session.prompt.accepted":
      return `Reef prompt ${frame.proposalId} was accepted by @${peer}.`;
    case "session.prompt.denied":
      return `Reef prompt ${frame.proposalId} was denied by @${peer}: ${frame.reason}.`;
    case "session.prompt.failed":
      return `Reef prompt ${frame.proposalId} failed at @${peer}: ${frame.message}`;
    case "session.grant.revoked":
      return `Reef session mount ${frame.mountId} was revoked by @${peer}.`;
  }
  throw new Error("unsupported Reef federation outcome");
}
