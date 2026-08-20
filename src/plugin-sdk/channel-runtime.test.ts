// Channel-runtime compatibility alias coverage: the restored subpath must keep
// re-exporting the same six runtime helpers as channel-outbound so published
// external channel plugins (e.g. packages that import createTypingCallbacks
// from "openclaw/plugin-sdk/channel-runtime") keep resolving on source
// checkouts of main.
import { describe, expect, it } from "vitest";
import * as channelOutbound from "./channel-outbound.js";
import * as channelRuntime from "./channel-runtime.js";

const RUNTIME_ALIAS_EXPORTS = [
  "createAccountStatusSink",
  "createReplyPrefixContext",
  "createReplyPrefixOptions",
  "createTypingCallbacks",
  "keepHttpServerTaskAlive",
  "waitUntilAbort",
] as const;

describe("plugin-sdk channel-runtime compatibility alias", () => {
  it("exposes every channel-outbound runtime helper through the alias", () => {
    for (const name of RUNTIME_ALIAS_EXPORTS) {
      expect(channelRuntime[name], name).toBe(channelOutbound[name]);
      expect(channelRuntime[name], name).toBeTypeOf("function");
    }
  });

  it("does not re-export unrelated channel-outbound helpers", () => {
    // The alias is deliberately narrow: typing/reply/status/lifecycle only.
    expect(Object.keys(channelRuntime).sort()).toEqual([...RUNTIME_ALIAS_EXPORTS].sort());
  });
});
