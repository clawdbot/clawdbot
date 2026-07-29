// Imessage tests cover accounts plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectIMessageDuplicateAccountSourceWarnings,
  hasExclusiveIMessageLocalDatabase,
  listEnabledIMessageAccounts,
  listIMessageAccountIds,
  resolveDefaultIMessageAccountId,
  resolveIMessageAccount,
  resolveIMessageDuplicateSourceOwner,
} from "./accounts.js";

describe("resolveIMessageAccount", () => {
  it("preserves top-level default account when named accounts are configured", () => {
    const cfg = {
      channels: {
        imessage: {
          cliPath: "/usr/local/bin/imsg",
          accounts: {
            work: { enabled: false },
          },
        },
      },
    } as never;

    expect(listIMessageAccountIds(cfg)).toEqual(["default", "work"]);
    expect(resolveDefaultIMessageAccountId(cfg)).toBe("default");
    expect(resolveIMessageAccount({ cfg }).config.cliPath).toBe("/usr/local/bin/imsg");
  });

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

  it("treats sendTransport as an intentional account config", () => {
    const resolved = resolveIMessageAccount({
      cfg: {
        channels: {
          imessage: {
            accounts: {
              work: {
                sendTransport: "bridge",
              },
            },
          },
        },
      } as never,
      accountId: "work",
    });

    expect(resolved.config.sendTransport).toBe("bridge");
    expect(resolved.configured).toBe(true);
  });
});

describe("iMessage duplicate-source watcher ownership", () => {
  it("flags default as a non-owner when a named account shares its source", () => {
    const cfg = {
      channels: {
        imessage: {
          accounts: {
            "swang430-gmail-com": {
              cliPath: "imsg",
              dmPolicy: "pairing",
              groupPolicy: "allowlist",
            },
            default: {
              dmPolicy: "pairing",
              groupPolicy: "allowlist",
            },
          },
        },
      },
    } as never;

    // Both accounts stay enabled so outbound, status, and capability surfaces
    // keep treating them normally; only the watcher startup path consults
    // resolveIMessageDuplicateSourceOwner to skip the redundant `imsg rpc`.
    const enabled = listEnabledIMessageAccounts(cfg).map((a) => a.accountId);
    expect(enabled).toEqual(["default", "swang430-gmail-com"]);

    const dupAccount = resolveIMessageAccount({ cfg, accountId: "default" });
    expect(resolveIMessageDuplicateSourceOwner({ cfg, account: dupAccount })).toBe(
      "swang430-gmail-com",
    );

    const ownerAccount = resolveIMessageAccount({ cfg, accountId: "swang430-gmail-com" });
    expect(resolveIMessageDuplicateSourceOwner({ cfg, account: ownerAccount })).toBeUndefined();
  });

  it("reports no duplicate ownership when accounts target different cliPaths", () => {
    const cfg = {
      channels: {
        imessage: {
          accounts: {
            work: { cliPath: "/usr/local/bin/imsg-work" },
            home: { cliPath: "/usr/local/bin/imsg-home" },
          },
        },
      },
    } as never;

    const enabled = listEnabledIMessageAccounts(cfg).map((a) => a.accountId);
    expect(enabled).toEqual(["home", "work"]);
    for (const accountId of enabled) {
      const account = resolveIMessageAccount({ cfg, accountId });
      expect(resolveIMessageDuplicateSourceOwner({ cfg, account })).toBeUndefined();
    }
  });

  it("ignores a disabled duplicate when computing ownership", () => {
    const cfg = {
      channels: {
        imessage: {
          accounts: {
            "swang430-gmail-com": {},
            default: { enabled: false },
          },
        },
      },
    } as never;

    const enabled = listEnabledIMessageAccounts(cfg).map((a) => a.accountId);
    expect(enabled).toEqual(["swang430-gmail-com"]);

    const ownerAccount = resolveIMessageAccount({ cfg, accountId: "swang430-gmail-com" });
    expect(resolveIMessageDuplicateSourceOwner({ cfg, account: ownerAccount })).toBeUndefined();
  });

  it("emits one preview warning per collision group", () => {
    const cfg = {
      channels: {
        imessage: {
          accounts: {
            "swang430-gmail-com": {},
            default: {},
          },
        },
      },
    } as never;

    const warnings = collectIMessageDuplicateAccountSourceWarnings({ cfg });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/channels\.imessage:/);
    expect(warnings[0]).toMatch(/swang430-gmail-com/);
    expect(warnings[0]).toMatch(/"default"/);
    expect(warnings[0]).toMatch(/cliPath=imsg/);
  });

  it("emits no warning when only one account is enabled", () => {
    const cfg = {
      channels: {
        imessage: {
          accounts: {
            "swang430-gmail-com": {},
            default: { enabled: false },
          },
        },
      },
    } as never;

    expect(collectIMessageDuplicateAccountSourceWarnings({ cfg })).toEqual([]);
  });
});

describe("iMessage local database account ownership", () => {
  function createLocalFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-imessage-account-db-"));
    const cliPath = path.join(root, "imsg");
    const firstDbPath = path.join(root, "first.db");
    const secondDbPath = path.join(root, "second.db");
    fs.writeFileSync(cliPath, Buffer.from("cafebabe", "hex"));
    fs.writeFileSync(firstDbPath, "");
    fs.writeFileSync(secondDbPath, "");
    return { root, cliPath, firstDbPath, secondDbPath };
  }

  it("rejects a database shared by two enabled accounts", () => {
    const fixture = createLocalFixture();
    try {
      const cfg = {
        channels: {
          imessage: {
            accounts: {
              work: { cliPath: fixture.cliPath, dbPath: fixture.firstDbPath },
              home: { cliPath: fixture.cliPath, dbPath: fixture.firstDbPath },
            },
          },
        },
      } as never;
      const account = resolveIMessageAccount({ cfg, accountId: "work" });

      expect(
        hasExclusiveIMessageLocalDatabase({
          cfg,
          account,
          cliPath: fixture.cliPath,
          dbPath: fixture.firstDbPath,
        }),
      ).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects hard-linked paths to the same database", () => {
    const fixture = createLocalFixture();
    const linkedDbPath = path.join(fixture.root, "linked.db");
    fs.linkSync(fixture.firstDbPath, linkedDbPath);
    try {
      const cfg = {
        channels: {
          imessage: {
            accounts: {
              work: { cliPath: fixture.cliPath, dbPath: fixture.firstDbPath },
              home: { cliPath: fixture.cliPath, dbPath: linkedDbPath },
            },
          },
        },
      } as never;
      const account = resolveIMessageAccount({ cfg, accountId: "work" });

      expect(
        hasExclusiveIMessageLocalDatabase({
          cfg,
          account,
          cliPath: fixture.cliPath,
          dbPath: fixture.firstDbPath,
        }),
      ).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("accepts distinct proven local databases and ignores explicit remote accounts", () => {
    const fixture = createLocalFixture();
    try {
      const cfg = {
        channels: {
          imessage: {
            accounts: {
              work: { cliPath: fixture.cliPath, dbPath: fixture.firstDbPath },
              home: { cliPath: fixture.cliPath, dbPath: fixture.secondDbPath },
              remote: { cliPath: "/usr/local/bin/remote-imsg", remoteHost: "qa@example.invalid" },
            },
          },
        },
      } as never;
      const account = resolveIMessageAccount({ cfg, accountId: "work" });

      expect(
        hasExclusiveIMessageLocalDatabase({
          cfg,
          account,
          cliPath: fixture.cliPath,
          dbPath: fixture.firstDbPath,
        }),
      ).toBe(true);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails closed when another local account source cannot be attested", () => {
    const fixture = createLocalFixture();
    try {
      const cfg = {
        channels: {
          imessage: {
            accounts: {
              work: { cliPath: fixture.cliPath, dbPath: fixture.firstDbPath },
              unknown: { cliPath: path.join(fixture.root, "unknown-imsg") },
            },
          },
        },
      } as never;
      const account = resolveIMessageAccount({ cfg, accountId: "work" });

      expect(
        hasExclusiveIMessageLocalDatabase({
          cfg,
          account,
          cliPath: fixture.cliPath,
          dbPath: fixture.firstDbPath,
        }),
      ).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
