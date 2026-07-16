import { describe, expect, it } from "vitest";
import { resolveIMessageAccount } from "./accounts.js";

describe("resolveIMessageAccount", () => {
  it("uses configured defaultAccount when accountId is omitted", () => {
    const resolved = resolveIMessageAccount({
      cfg: {
        channels: {
          imessage: {
            defaultAccount: "work",
            accounts: {
              work: {
                name: "Work",
                cliPath: "/usr/local/bin/imsg-work",
                dmPolicy: "open",
              },
            },
          },
        },
      } as never,
    });

    expect(resolved.accountId).toBe("work");
    expect(resolved.name).toBe("Work");
    expect(resolved.config.cliPath).toBe("/usr/local/bin/imsg-work");
    expect(resolved.config.dmPolicy).toBe("open");
    expect(resolved.configured).toBe(true);
  });
});
