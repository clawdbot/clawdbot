import { normalizeStringifiedOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { getMatrixRuntime } from "../../runtime.js";
import type { MatrixConfig } from "../../types.js";
import type { MatrixClient } from "../sdk.js";
import type { RuntimeEnv } from "./runtime-api.js";

export function registerMatrixAutoJoin(params: {
  client: MatrixClient;
  accountConfig: Pick<MatrixConfig, "autoJoin" | "autoJoinAllowlist">;
  runtime: RuntimeEnv;
}) {
  const { client, accountConfig, runtime } = params;
  const core = getMatrixRuntime();
  const logVerbose = (message: string) => {
    if (!core.logging.shouldLogVerbose()) {
      return;
    }
    runtime.log?.(message);
  };
  const autoJoin = accountConfig.autoJoin ?? "off";
  const rawAllowlist = (accountConfig.autoJoinAllowlist ?? [])
    .map((entry) => normalizeStringifiedOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
  const autoJoinAllowlist = new Set(rawAllowlist);
  const allowedRoomIds = new Set(rawAllowlist.filter((entry) => entry.startsWith("!")));
  const allowedAliases = rawAllowlist.filter((entry) => entry.startsWith("#"));
  const resolvedAliasRoomIds = new Map<string, string>();

  if (autoJoin === "off") {
    return;
  }

  if (autoJoin === "always") {
    logVerbose("matrix: auto-join enabled for all invites");
  } else {
    logVerbose("matrix: auto-join enabled for allowlist invites");
  }

  const resolveAllowedAliasRoomId = async (alias: string): Promise<string | null> => {
    if (resolvedAliasRoomIds.has(alias)) {
      return resolvedAliasRoomIds.get(alias) ?? null;
    }
    const resolved = await params.client.resolveRoom(alias);
    if (resolved) {
      resolvedAliasRoomIds.set(alias, resolved);
    }
    return resolved;
  };

  const resolveAllowedAliasRoomIds = async (): Promise<string[]> => {
    const resolved = await Promise.all(
      allowedAliases.map(async (alias) => {
        try {
          return await resolveAllowedAliasRoomId(alias);
        } catch (err) {
          runtime.error?.(`matrix: failed resolving allowlisted alias ${alias}: ${String(err)}`);
          return null;
        }
      }),
    );
    return resolved.filter((roomId): roomId is string => Boolean(roomId));
  };

  // Handle invites directly so both "always" and "allowlist" modes share the same path.
  client.on("room.invite", async (roomId: string, _inviteEvent: unknown) => {
    if (autoJoin === "allowlist") {
      const allowedAliasRoomIds = await resolveAllowedAliasRoomIds();
      const allowed =
        autoJoinAllowlist.has("*") ||
        allowedRoomIds.has(roomId) ||
        allowedAliasRoomIds.some((resolvedRoomId) => resolvedRoomId === roomId);

      if (!allowed) {
        logVerbose(`matrix: invite ignored (not in allowlist) room=${roomId}`);
        return;
      }
    }

    try {
      await client.joinRoom(roomId);
      logVerbose(`matrix: joined room ${roomId}`);
    } catch (err) {
      runtime.error?.(`matrix: failed to join room ${roomId}: ${String(err)}`);
    }
  });
}
