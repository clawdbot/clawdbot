import { describe, expect, it } from "vitest";
import {
  resolveIMessageConfigAllowFrom,
  resolveIMessageConfigDefaultTo,
} from "./config-accessors.js";

describe("imessage config accessors", () => {
  it("reads merged allowFrom/defaultTo from resolved account config", () => {
    const cfg = {
      channels: {
        imessage: {
          defaultTo: " root:chat ",
          allowFrom: ["root"],
          accounts: {
            alt: {
              defaultTo: " alt:chat ",
              allowFrom: ["chat_id:9", "user@example.com"],
            },
          },
        },
      },
    };

    expect(resolveIMessageConfigAllowFrom({ cfg, accountId: "alt" })).toEqual([
      "chat_id:9",
      "user@example.com",
    ]);
    expect(resolveIMessageConfigDefaultTo({ cfg, accountId: "alt" })).toBe("alt:chat");
  });
});
