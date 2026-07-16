import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildChannelAccountSnapshotFromAccount } from "./status.js";
import type { ChannelPlugin } from "./types.plugin.js";

describe("buildChannelAccountSnapshotFromAccount", () => {
  it("redacts a custom status snapshot baseUrl without mutating the resolved account", async () => {
    const rawBaseUrl = [
      "https://",
      "user",
      ":",
      "pass",
      "@",
      "chat.example.test/?token=",
      "secret",
    ].join("");
    const account = Object.freeze({
      baseUrl: rawBaseUrl,
    });
    let receivedAccount: unknown;
    const plugin = {
      config: {},
      status: {
        buildAccountSnapshot: ({ account: hookAccount }: { account: unknown }) => {
          receivedAccount = hookAccount;
          return {
            accountId: "custom",
            baseUrl: (hookAccount as { baseUrl: string }).baseUrl,
          };
        },
      },
    } as unknown as ChannelPlugin<typeof account>;

    const snapshot = await buildChannelAccountSnapshotFromAccount({
      plugin,
      cfg: {} as OpenClawConfig,
      accountId: "default",
      account,
    });

    expect(receivedAccount).toBe(account);
    expect(snapshot.baseUrl).toBe("https://chat.example.test/?token=***");
    expect(account.baseUrl).toBe(rawBaseUrl);
  });
});
