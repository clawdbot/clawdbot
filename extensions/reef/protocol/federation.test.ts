import { describe, expect, it } from "vitest";
import { open, seal, validateMessageBody } from "./envelope.js";
import {
  createReefFederatedPromptDigest,
  REEF_FEDERATION_NAMESPACE,
  validateReefFederationBody,
  type ReefFederationBody,
} from "./federation.js";
import { generateIdentity } from "./identity.js";
import { MemoryReplayStore } from "./replay.js";

const envelopeId = "01JZ0000000000000000000000";

function proposedBody(text = "inspect the failing build"): ReefFederationBody {
  const binding = {
    from: "guest#1",
    to: "host#2",
    mountId: "mount-1",
    proposalId: "proposal-1",
    sessionId: "session-1",
    grantGeneration: 3,
    text,
  };
  return {
    namespace: REEF_FEDERATION_NAMESPACE,
    frame: {
      type: "session.prompt.propose",
      mountId: binding.mountId,
      proposalId: binding.proposalId,
      sessionId: binding.sessionId,
      grantGeneration: binding.grantGeneration,
      text,
      textSha256: createReefFederatedPromptDigest(binding),
    },
  };
}

describe("Reef session federation protocol", () => {
  it("seals and opens a typed federation frame", async () => {
    const guest = generateIdentity();
    const host = generateIdentity();
    const body = proposedBody();
    const envelope = seal({
      id: envelopeId,
      from: "guest#1",
      to: "host#2",
      body,
      senderSigningSecretKey: guest.signing.secretKey,
      recipientEncryptionPublicKey: host.encryption.publicKey,
      ts: 1_756_000_000,
    });

    await expect(
      open({
        envelope,
        self: "host#2",
        recipientEncryptionSecretKey: host.encryption.secretKey,
        senderSigningPublicKey: guest.signing.publicKey,
        replayStore: new MemoryReplayStore(),
        now: 1_756_000_000,
      }),
    ).resolves.toEqual(body);
  });

  it("binds the digest to both peers and the session authority", () => {
    const body = proposedBody();
    const frame = body.frame;
    if (frame.type !== "session.prompt.propose") {
      throw new Error("expected prompt frame");
    }
    const expected = frame.textSha256;
    const base = {
      from: "guest#1",
      to: "host#2",
      mountId: frame.mountId,
      proposalId: frame.proposalId,
      sessionId: frame.sessionId,
      grantGeneration: frame.grantGeneration,
      text: frame.text,
    };

    expect(createReefFederatedPromptDigest(base)).toBe(expected);
    expect(createReefFederatedPromptDigest({ ...base, from: "attacker#1" })).not.toBe(expected);
    expect(createReefFederatedPromptDigest({ ...base, sessionId: "session-2" })).not.toBe(expected);
    expect(createReefFederatedPromptDigest({ ...base, grantGeneration: 4 })).not.toBe(expected);
  });

  it("rejects unknown and over-broad federation frames", () => {
    expect(() =>
      validateReefFederationBody({
        ...proposedBody(),
        frame: { ...proposedBody().frame, unexpected: true },
      }),
    ).toThrow("invalid federation frame fields");
    expect(() =>
      validateMessageBody({
        namespace: REEF_FEDERATION_NAMESPACE,
        frame: { type: "session.prompt.execute", mountId: "mount-1" },
      }),
    ).toThrow("invalid federation body");
  });
});
