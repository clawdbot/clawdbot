import { describe, expect, it } from "vitest";
import {
  listSignalAccountIds,
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
} from "./accounts.js";

describe("resolveSignalAccount", () => {
  it("preserves top-level default account when named accounts are configured", () => {
    const cfg = {
      channels: {
        signal: {
          account: "+15555550123",
          accounts: {
            work: { enabled: false },
          },
        },
      },
    } as never;

    expect(listSignalAccountIds(cfg)).toEqual(["default", "work"]);
    expect(resolveDefaultSignalAccountId(cfg)).toBe("default");
    expect(resolveSignalAccount({ cfg }).config.account).toBe("+15555550123");
  });

  it("uses configured defaultAccount when accountId is omitted", () => {
    const resolved = resolveSignalAccount({
      cfg: {
        channels: {
          signal: {
            defaultAccount: "work",
            accounts: {
              work: {
                name: "Work",
                account: "+15555550123",
                httpUrl: "http://127.0.0.1:9999",
              },
            },
          },
        },
      } as never,
    });

    expect(resolved.accountId).toBe("work");
    expect(resolved.name).toBe("Work");
    expect(resolved.baseUrl).toBe("http://127.0.0.1:9999");
    expect(resolved.config.account).toBe("+15555550123");
    expect(resolved.configured).toBe(true);
  });
});
