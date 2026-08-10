/**
 * Opaque proof that one adapter-attested direct message passed the complete
 * ingress graph. The proof is process-local so model fields, plugin extras,
 * and caller-shaped objects cannot manufacture a memory identity binding.
 */
import { normalizeAccountId } from "../../routing/account-id.js";

const memoryIdentityAdmissionBrand: unique symbol = Symbol("openclaw.memory-identity-admission");

export type AdmittedChannelMemoryIdentity = Readonly<{
  readonly [memoryIdentityAdmissionBrand]: true;
}>;

type AdmissionFacts = Readonly<{
  channel: string;
  accountId: string;
  stableSenderId: string;
  adapterId: string;
  assurance: "authenticated" | "adapter-attested";
  verificationMethod: string;
  evidenceRevision: string;
}>;

const admissions = new WeakMap<object, AdmissionFacts>();
const admissionsByInboundContext = new WeakMap<object, AdmittedChannelMemoryIdentity>();

export type ChannelMemoryIdentityAdmission = Readonly<{
  /**
   * A loaded channel adapter calls this only after it has authenticated the
   * provider envelope. The adapter is the transport TCB; core verifies the
   * committed direct-session route before resolving a principal.
   */
  attachVerifiedDirectSender: (params: {
    context: object;
    channel: string;
    accountId: string;
    stableSenderId: string;
  }) => void;
  /**
   * Mint a one-use proof for authenticated direct ingress before pairing has
   * approved the sender. The pairing store consumes it atomically with the
   * pending request; plugins cannot inspect or persist the proof.
   */
  admitVerifiedDirectPairingSender: (params: {
    channel: string;
    accountId: string;
    stableSenderId: string;
  }) => AdmittedChannelMemoryIdentity | undefined;
}>;

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new TypeError(`${label} must not be empty`);
  }
  return normalized;
}

/**
 * Minted from a transport-authenticated sender attestation. Core later binds
 * directness and admitted routing to the committed session row.
 */
function admitChannelMemoryIdentity(params: {
  channel: string;
  accountId: string;
  stableSenderId: string;
  adapterId: string;
  assurance: "authenticated" | "adapter-attested";
  verificationMethod: string;
  evidenceRevision: string;
}): AdmittedChannelMemoryIdentity {
  const proof = Object.freeze(
    Object.defineProperty(Object.create(null), memoryIdentityAdmissionBrand, {
      value: true,
      enumerable: false,
    }),
  ) as AdmittedChannelMemoryIdentity;
  admissions.set(
    proof,
    Object.freeze({
      channel: requireText(params.channel, "channel").toLowerCase(),
      accountId: normalizeAccountId(requireText(params.accountId, "accountId")),
      stableSenderId: requireText(String(params.stableSenderId), "stableSenderId"),
      adapterId: requireText(params.adapterId, "adapterId"),
      assurance: params.assurance,
      verificationMethod: requireText(params.verificationMethod, "verificationMethod"),
      evidenceRevision: requireText(params.evidenceRevision, "evidenceRevision"),
    }),
  );
  return proof;
}

/**
 * Loader-owned channel capability. It is not attached to the shared channel
 * runtime: only a loaded, trusted adapter with the registered channel id can
 * ask core to turn its post-transport-auth facts into an opaque proof.
 */
export function createChannelMemoryIdentityAdmission(params: {
  pluginId: string;
  adapterId: string;
  ownsChannel: (channel: string) => boolean;
  isActive: () => boolean;
}): ChannelMemoryIdentityAdmission {
  const pluginId = requireText(params.pluginId, "pluginId");
  const adapterId = requireText(params.adapterId, "adapterId");
  const attach = (input: {
    context: object;
    channel: string;
    accountId: string;
    stableSenderId: string;
  }): void => {
    const channel = requireText(input.channel, "channel").toLowerCase();
    if (!params.isActive() || !params.ownsChannel(channel)) {
      return;
    }
    const proof = admitChannelMemoryIdentity({
      channel,
      accountId: input.accountId,
      stableSenderId: input.stableSenderId,
      adapterId,
      assurance: "adapter-attested",
      verificationMethod: "channel-adapter-post-transport-auth",
      evidenceRevision: `channel:${channel}:plugin:${pluginId}`,
    });
    // The loader-bound adapter only attests a transport-verified sender. Core
    // derives directness and final routed admission from the committed session.
    admissionsByInboundContext.set(input.context, proof);
  };
  const admitPairing = (input: {
    channel: string;
    accountId: string;
    stableSenderId: string;
  }): AdmittedChannelMemoryIdentity | undefined => {
    const channel = requireText(input.channel, "channel").toLowerCase();
    if (!params.isActive() || !params.ownsChannel(channel)) {
      return undefined;
    }
    return admitChannelMemoryIdentity({
      channel,
      accountId: input.accountId,
      stableSenderId: input.stableSenderId,
      adapterId,
      assurance: "adapter-attested",
      verificationMethod: "channel-adapter-post-transport-auth-pairing",
      evidenceRevision: `channel:${channel}:plugin:${pluginId}`,
    });
  };
  return Object.freeze({
    attachVerifiedDirectSender: attach,
    admitVerifiedDirectPairingSender: admitPairing,
  });
}

/** Consume the one-use adapter proof bound to an exact finalized inbound context. */
export function consumeAdmittedChannelMemoryIdentityFromContext(
  context: object,
): AdmittedChannelMemoryIdentity | undefined {
  const proof = admissionsByInboundContext.get(context);
  admissionsByInboundContext.delete(context);
  return proof;
}

/** Consume a proof at the core-owned admin-link writer. */
export function consumeAdmittedChannelMemoryIdentity(
  admission: unknown,
): AdmissionFacts | undefined {
  if (!admission || typeof admission !== "object") {
    return undefined;
  }
  const facts = admissions.get(admission);
  if (!facts) {
    return undefined;
  }
  admissions.delete(admission);
  return facts;
}
