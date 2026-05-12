import { describe, expect, it } from "vitest";
import {
  hasBundledChannelPersistedAuthState,
  listBundledChannelIdsWithPersistedAuthState,
} from "./persisted-auth-state.js";

describe("bundled channel persisted-auth metadata", () => {
  it("lists shipped persisted-auth metadata channels", () => {
    expect(listBundledChannelIdsWithPersistedAuthState()).toEqual(["matrix", "whatsapp"]);
  });

  it("does not report auth state for channels without bundled metadata", () => {
    expect(
      hasBundledChannelPersistedAuthState({
        channelId: "discord",
        cfg: {},
        env: {},
      }),
    ).toBe(false);
  });
});
