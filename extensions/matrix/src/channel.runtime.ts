// Matrix plugin module implements channel behavior.
import { listMatrixDirectoryGroupsLive, listMatrixDirectoryPeersLive } from "./directory-live.js";
import { resolveMatrixAuth } from "./matrix/client.js";
import { cleanupMatrixDeliveryPlans, reconcileMatrixUnknownSend } from "./matrix/delivery-plan.js";
import { probeMatrix } from "./matrix/probe.js";
import { sendMessageMatrix, sendTypingMatrix } from "./matrix/send.js";
import { withResolvedMatrixControlClient } from "./matrix/send/client.js";
import { resolveMatrixRoomId } from "./matrix/send/targets.js";
import { matrixOutbound } from "./outbound.js";
import { resolveMatrixTargets } from "./resolve-targets.js";
import type { CoreConfig } from "./types.js";

async function resolveMatrixRoomAliasTarget(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  alias: string;
}): Promise<string> {
  return await withResolvedMatrixControlClient(
    { cfg: params.cfg, accountId: params.accountId },
    async (client) => await resolveMatrixRoomId(client, params.alias),
  );
}

export const matrixChannelRuntime = {
  cleanupMatrixDeliveryPlans,
  listMatrixDirectoryGroupsLive,
  listMatrixDirectoryPeersLive,
  matrixOutbound,
  probeMatrix,
  resolveMatrixAuth,
  resolveMatrixRoomAliasTarget,
  resolveMatrixTargets,
  reconcileMatrixUnknownSend,
  sendMessageMatrix,
  sendTypingMatrix,
};
