import type {
  ChannelDirectoryEntry,
  DirectoryConfigParams,
} from "openclaw/plugin-sdk/directory-runtime";
import { queryBuzzDirectoryProfiles, queryBuzzDirectoryRooms } from "./directory-relay.js";
import { BuzzDirectoryState } from "./directory-state.js";
import { getActiveBuzzBus } from "./gateway.js";
import { connectAuthenticatedBuzzRelaySession, parseBuzzAuthTag } from "./relay-auth.js";
import { queryBuzzRoomMemberships } from "./room-membership-query.js";
import { parseBuzzTarget } from "./target.js";
import { decodeBuzzPrivateKey, resolveBuzzAccount } from "./types.js";

const DIRECTORY_LIVE_TIMEOUT_MS = 10_000;

function resolveConfiguredRoomIds(account: ReturnType<typeof resolveBuzzAccount>): string[] {
  return Object.entries(account.config.groups ?? {})
    .filter(([, config]) => config.enabled !== false)
    .map(([roomId]) => parseBuzzTarget(roomId));
}

function createConfiguredDirectoryState(params: DirectoryConfigParams): {
  account: ReturnType<typeof resolveBuzzAccount>;
  channelIds: string[];
  state: BuzzDirectoryState;
} | null {
  const account = resolveBuzzAccount({ cfg: params.cfg, accountId: params.accountId });
  if (!account.publicKey) {
    return null;
  }
  const channelIds = resolveConfiguredRoomIds(account);
  return {
    account,
    channelIds,
    state: new BuzzDirectoryState({
      publicKey: account.publicKey,
      fallbackProfileName: account.name ?? "OpenClaw",
      channelIds,
    }),
  };
}

async function loadBuzzDirectoryState(
  params: DirectoryConfigParams,
  options: { refreshRooms: boolean },
): Promise<BuzzDirectoryState | null> {
  const configured = createConfiguredDirectoryState(params);
  if (!configured || !configured.account.configured || configured.channelIds.length === 0) {
    return configured?.state ?? null;
  }
  const activeBus = getActiveBuzzBus(configured.account.accountId);
  if (activeBus) {
    if (options.refreshRooms) {
      try {
        await activeBus.refreshDirectory();
      } catch {
        // A stalled metadata refresh recycles the relay session. Directory
        // reads can still return the last complete in-memory snapshot.
      }
    }
    return activeBus.directory;
  }

  const timeoutSignal = AbortSignal.timeout(DIRECTORY_LIVE_TIMEOUT_MS);
  const { relay, relayPublicKey } = await connectAuthenticatedBuzzRelaySession({
    relayUrl: configured.account.relayUrl,
    secretKey: decodeBuzzPrivateKey(configured.account.privateKey),
    authTag: parseBuzzAuthTag(configured.account.authTag),
    signal: timeoutSignal,
  });
  try {
    await queryBuzzDirectoryRooms({
      relay,
      relayPublicKey,
      state: configured.state,
      channelIds: configured.channelIds,
      signal: timeoutSignal,
    });
    const activeChannelIds = configured.state.activeRoomIds();
    configured.state.replaceMemberships(
      activeChannelIds.length > 0
        ? await queryBuzzRoomMemberships({
            relay,
            relayPublicKey,
            channelIds: activeChannelIds,
            signal: timeoutSignal,
          })
        : new Map(),
    );
    await queryBuzzDirectoryProfiles({
      relay,
      state: configured.state,
      publicKeys: configured.state.profilePublicKeys(),
      signal: timeoutSignal,
    });
    return configured.state;
  } finally {
    relay.close();
  }
}

export async function getBuzzDirectorySelf(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry | null> {
  return (await loadBuzzDirectoryState(params, { refreshRooms: false }))?.self() ?? null;
}

export async function listBuzzDirectoryPeersLive(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  return (
    (await loadBuzzDirectoryState(params, { refreshRooms: false }))?.listPeers({
      query: params.query,
      limit: params.limit,
    }) ?? []
  );
}

export async function listBuzzDirectoryGroupsLive(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  return (
    (await loadBuzzDirectoryState(params, { refreshRooms: true }))?.listGroups({
      query: params.query,
      limit: params.limit,
    }) ?? []
  );
}

export async function listBuzzDirectoryGroupMembers(params: {
  cfg: DirectoryConfigParams["cfg"];
  accountId?: string | null;
  groupId: string;
  limit?: number | null;
}): Promise<ChannelDirectoryEntry[]> {
  return (
    (await loadBuzzDirectoryState(params, { refreshRooms: false }))?.listGroupMembers({
      groupId: params.groupId,
      limit: params.limit,
    }) ?? []
  );
}
