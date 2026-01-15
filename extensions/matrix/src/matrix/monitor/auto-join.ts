import type { MatrixClient, MatrixEvent, RoomMember } from "matrix-js-sdk";
import { RoomMemberEvent } from "matrix-js-sdk";

import { danger, logVerbose } from "../../../../../src/globals.js";
import type { RuntimeEnv } from "../../../../../src/runtime.js";
import type { CoreConfig } from "../../types.js";

export function registerMatrixAutoJoin(params: {
  client: MatrixClient;
  cfg: CoreConfig;
  runtime: RuntimeEnv;
}) {
  const { client, cfg, runtime } = params;
  const autoJoin = cfg.channels?.matrix?.autoJoin ?? "always";
  const autoJoinAllowlist = cfg.channels?.matrix?.autoJoinAllowlist ?? [];

  client.on(RoomMemberEvent.Membership, async (_event: MatrixEvent, member: RoomMember) => {
    if (member.userId !== client.getUserId()) return;
    if (member.membership !== "invite") return;
    const roomId = member.roomId;
    if (autoJoin === "off") return;
    if (autoJoin === "allowlist") {
      const invitedRoom = client.getRoom(roomId);
      const alias = invitedRoom?.getCanonicalAlias?.() ?? "";
      const altAliases = invitedRoom?.getAltAliases?.() ?? [];
      const allowed =
        autoJoinAllowlist.includes("*") ||
        autoJoinAllowlist.includes(roomId) ||
        (alias ? autoJoinAllowlist.includes(alias) : false) ||
        altAliases.some((value) => autoJoinAllowlist.includes(value));
      if (!allowed) {
        logVerbose(`matrix: invite ignored (not in allowlist) room=${roomId}`);
        return;
      }
    }
    try {
      await client.joinRoom(roomId);
      logVerbose(`matrix: joined room ${roomId}`);
    } catch (err) {
      runtime.error?.(danger(`matrix: failed to join room ${roomId}: ${String(err)}`));
    }
  });
}
