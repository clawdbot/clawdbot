import { describe, expect, it } from "vitest";
import { resolveSignalAccount } from "./accounts.js";

describe("resolveSignalAccount", () => {
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
