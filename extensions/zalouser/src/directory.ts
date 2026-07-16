import { resolveZalouserAccountSync } from "./accounts.js";
import type { ChannelDirectoryEntry, OpenClawConfig } from "./channel-api.js";
import { parseZalouserDirectoryGroupId } from "./session-route.js";

type ZalouserDirectoryDeps = {
  listZaloGroupMembers: (
    profile: string,
    groupId: string,
  ) => Promise<
    Array<{
      userId: string;
      displayName?: string | null;
      avatar?: string | null;
    }>
  >;
};

function mapUser(params: {
  id: string;
  name?: string | null;
  avatarUrl?: string | null;
  raw?: unknown;
}): ChannelDirectoryEntry {
  return {
    kind: "user",
    id: params.id,
    name: params.name ?? undefined,
    avatarUrl: params.avatarUrl ?? undefined,
    raw: params.raw,
  };
}

export async function listZalouserDirectoryGroupMembers(
  params: {
    cfg: OpenClawConfig;
    accountId?: string;
    groupId: string;
    limit?: number;
  },
  deps: ZalouserDirectoryDeps,
) {
  const account = resolveZalouserAccountSync({ cfg: params.cfg, accountId: params.accountId });
  const normalizedGroupId = parseZalouserDirectoryGroupId(params.groupId);
  const members = await deps.listZaloGroupMembers(account.profile, normalizedGroupId);
  const rows = members.map((member) =>
    mapUser({
      id: member.userId,
      name: member.displayName,
      avatarUrl: member.avatar ?? null,
      raw: member,
    }),
  );
  return typeof params.limit === "number" && params.limit > 0 ? rows.slice(0, params.limit) : rows;
}
