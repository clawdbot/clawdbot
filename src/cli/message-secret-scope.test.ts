import { describe, expect, it } from "vitest";
import { resolveMessageSecretScope } from "./message-secret-scope.js";

describe("resolveMessageSecretScope", () => {
  it("prefers explicit channel/account inputs", () => {
    expect(
      resolveMessageSecretScope({
        channel: "Signal",
        accountId: "Ops",
      }),
    ).toEqual({
      channel: "signal",
      accountId: "ops",
    });
  });

  it("infers channel from a prefixed target", () => {
    expect(
      resolveMessageSecretScope({
        target: "signal:12345",
      }),
    ).toEqual({
      channel: "signal",
    });
  });

  it("infers a shared channel from target arrays", () => {
    expect(
      resolveMessageSecretScope({
        targets: ["signal:one", "signal:two"],
      }),
    ).toEqual({
      channel: "signal",
    });
  });

  it("does not infer a channel when target arrays mix channels", () => {
    expect(
      resolveMessageSecretScope({
        targets: ["signal:one", "imessage:two"],
      }),
    ).toStrictEqual({});
  });

  it("uses fallback channel/account when direct inputs are missing", () => {
    expect(
      resolveMessageSecretScope({
        fallbackChannel: "Signal",
        fallbackAccountId: "Chat",
      }),
    ).toEqual({
      channel: "signal",
      accountId: "chat",
    });
  });
});
