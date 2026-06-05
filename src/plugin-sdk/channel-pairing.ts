// Channel pairing contracts describe account/device pairing state shared by channel plugins.
import type { ChannelId } from "../channels/plugins/types.public.js";
export {
  createLoggedPairingApprovalNotifier,
  createPairingPrefixStripper,
  createTextPairingAdapter,
} from "../channels/plugins/pairing-adapters.js";
export {
  readChannelAllowFromStore,
  readChannelAllowFromStoreSync,
} from "../pairing/pairing-store.js";
export { resolveChannelAllowFromPath } from "../pairing/pairing-store.js";
import { issuePairingChallenge } from "../pairing/pairing-challenge.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { createScopedPairingAccess } from "./pairing-access.js";

type ScopedPairingAccess = ReturnType<typeof createScopedPairingAccess>;

/** Pairing helpers scoped to one channel account. */
export type ChannelPairingController = ScopedPairingAccess & {
  /** Issue a pairing challenge using the controller's channel and scoped store writer. */
  issueChallenge: (
    params: Omit<Parameters<typeof issuePairingChallenge>[0], "channel" | "upsertPairingRequest">,
  ) => ReturnType<typeof issuePairingChallenge>;
};

/** Pre-bind the channel id and storage sink for pairing challenges. */
export function createChannelPairingChallengeIssuer(params: {
  /** Channel id attached to every challenge issued by the returned helper. */
  channel: ChannelId;
  /** Store writer that persists pending pairing requests for the bound channel. */
  upsertPairingRequest: Parameters<typeof issuePairingChallenge>[0]["upsertPairingRequest"];
}) {
  return (
    /** Challenge details supplied at message handling time. */
    challenge: Omit<
      Parameters<typeof issuePairingChallenge>[0],
      "channel" | "upsertPairingRequest"
    >,
  ) =>
    issuePairingChallenge({
      channel: params.channel,
      upsertPairingRequest: params.upsertPairingRequest,
      ...challenge,
    });
}

/** Build the full scoped pairing controller used by channel runtime code. */
export function createChannelPairingController(params: {
  /** Plugin runtime that provides pairing store operations. */
  core: PluginRuntime;
  /** Channel id scoped into reads, writes, and issued challenges. */
  channel: ChannelId;
  /** Channel account id normalized before pairing store access. */
  accountId: string;
}): ChannelPairingController {
  const access = createScopedPairingAccess(params);
  return {
    ...access,
    issueChallenge: createChannelPairingChallengeIssuer({
      channel: params.channel,
      upsertPairingRequest: access.upsertPairingRequest,
    }),
  };
}
