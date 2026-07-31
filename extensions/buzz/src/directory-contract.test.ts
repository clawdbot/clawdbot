// Buzz tests cover the lightweight config-backed directory contract.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  listBuzzDirectoryGroupsFromConfig,
  listBuzzDirectoryPeersFromConfig,
} from "../directory-contract-api.js";

const ROOM_A = "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c";
const ROOM_B = "940d0c32-4eb7-46d7-9d5b-d975aaef87f7";

describe("Buzz directory contract", () => {
  it("lists enabled configured rooms with query and limit filtering", async () => {
    const cfg = {
      channels: {
        buzz: {
          groups: {
            [ROOM_B]: { enabled: false },
            [ROOM_A]: {},
          },
        },
      },
    } as unknown as OpenClawConfig;

    await expect(
      listBuzzDirectoryGroupsFromConfig({
        cfg,
        accountId: "default",
        query: ROOM_A.slice(0, 8),
        limit: 1,
      }),
    ).resolves.toEqual([
      {
        kind: "group",
        id: `buzz:${ROOM_A}`,
        name: ROOM_A,
        raw: { roomId: ROOM_A },
      },
    ]);
    await expect(
      listBuzzDirectoryPeersFromConfig({
        cfg,
        accountId: "default",
        query: null,
        limit: null,
      }),
    ).resolves.toEqual([]);
  });
});
