// Shared first-owner bootstrap for DM pairing approval surfaces.
import {
  formatCommandOwnerFromChannelSender,
  hasConfiguredCommandOwners,
} from "../commands/doctor-command-owner.js";
import { readConfigFileSnapshotForWrite, replaceConfigFile } from "../config/config.js";
import type { PairingChannel } from "./pairing-store.types.js";

type PairingCommandOwnerBootstrapResult = {
  ownerEntry: string | null;
  status: "configured" | "already-configured" | "unavailable";
};

/** Adds the approved sender as command owner only when no owner exists yet. */
export async function bootstrapCommandOwnerFromPairing(params: {
  channel: PairingChannel;
  id: string;
}): Promise<PairingCommandOwnerBootstrapResult> {
  const ownerEntry = formatCommandOwnerFromChannelSender(params);
  if (!ownerEntry) {
    return { ownerEntry: null, status: "unavailable" };
  }

  const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
  if (hasConfiguredCommandOwners(snapshot.sourceConfig)) {
    return { ownerEntry, status: "already-configured" };
  }

  const nextConfig = structuredClone(snapshot.sourceConfig);
  nextConfig.commands = {
    ...nextConfig.commands,
    ownerAllowFrom: [ownerEntry],
  };
  await replaceConfigFile({
    nextConfig,
    snapshot,
    writeOptions,
    afterWrite: { mode: "auto" },
  });
  return { ownerEntry, status: "configured" };
}
