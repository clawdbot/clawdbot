import { listMatrixDirectoryGroupsLive, listMatrixDirectoryPeersLive } from "./directory-live.js";
import { resolveMatrixAuth } from "./matrix/client.js";
import { probeMatrix } from "./matrix/probe.js";
import { sendMessageMatrix } from "./matrix/send.js";
import { matrixOutbound } from "./outbound.js";
import { resolveMatrixTargets } from "./resolve-targets.js";

export const matrixChannelRuntime = {
  listMatrixDirectoryGroupsLive,
  listMatrixDirectoryPeersLive,
  matrixOutbound,
  probeMatrix,
  resolveMatrixAuth,
  resolveMatrixTargets,
  sendMessageMatrix,
};
