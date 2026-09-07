import type { SessionsListParams } from "../../../packages/gateway-protocol/src/index.js";
import { listBoardSessionKeysReadOnly } from "../../boards/sqlite-board-store.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { GatewayStoredSessionTargets } from "../../config/sessions/combined-store-gateway.js";
import { prepareSessionSharing } from "../session-sharing.js";

function listBoardSessionKeys(targets: GatewayStoredSessionTargets): ReadonlySet<string> {
  const inventories = new Map<string, ReadonlySet<string>>();
  const keys = new Set<string>();
  for (const [key, { storeKey, storeTarget }] of targets) {
    const identity = `${storeTarget.agentId}\0${storeTarget.storePath}`;
    let inventory = inventories.get(identity);
    if (!inventory) {
      inventory = listBoardSessionKeysReadOnly({
        agentId: storeTarget.agentId,
        path: storeTarget.storePath,
      });
      inventories.set(identity, inventory);
    }
    // Equal sentinel keys in another store do not describe this selected row's board.
    if (inventory.has(storeKey ?? key)) {
      keys.add(key);
    }
  }
  return keys;
}

export function listFilter(input: {
  cfg: Parameters<typeof prepareSessionSharing>[0]["cfg"];
  client: Parameters<typeof prepareSessionSharing>[0]["client"];
  loaded: { targetsBySessionKey: GatewayStoredSessionTargets };
  options: { excludedKeys?: ReadonlySet<string> };
  p: SessionsListParams;
}): ((key: string, entry: SessionEntry) => boolean) | undefined {
  const { loaded, p: params } = input;
  const visibilityFilter = prepareSessionSharing({
    client: input.client,
    cfg: input.cfg,
  }).entryFilter;
  const excludedKeys = input.options.excludedKeys;
  const boardSessionKeys =
    params.hasBoard === undefined ? undefined : listBoardSessionKeys(loaded.targetsBySessionKey);
  if (!visibilityFilter && !boardSessionKeys && !excludedKeys?.size) {
    return undefined;
  }
  return (key, entry) =>
    !excludedKeys?.has(key) &&
    (visibilityFilter?.(key, entry) ?? true) &&
    (params.hasBoard === undefined || boardSessionKeys?.has(key) === params.hasBoard);
}
