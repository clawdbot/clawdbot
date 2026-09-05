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
  it.each([
    ["absent channel", {}, undefined, "default", true, false],
    ["empty channel", { channels: { imessage: {} } }, undefined, "default", true, false],
    [
      "explicitly enabled channel with default paths",
      { channels: { imessage: { enabled: true } } },
      undefined,
      "default",
      true,
      true,
    ],
    [
      "explicitly disabled channel",
      { channels: { imessage: { enabled: false } } },
      undefined,
      "default",
      false,
      false,
    ],
    [
      "explicitly enabled channel with an existing CLI path",
      { channels: { imessage: { enabled: true, cliPath: "imsg" } } },
      undefined,
      "default",
      true,
      true,
    ],
    [
      "explicitly enabled named account",
      { channels: { imessage: { accounts: { work: { enabled: true } } } } },
      "work",
      "work",
      true,
      true,
    ],
    [
      "explicitly disabled named account",
      { channels: { imessage: { accounts: { work: { enabled: false } } } } },
      "work",
      "work",
      false,
      false,
    ],
    [
      "empty named account",
      { channels: { imessage: { accounts: { work: {} } } } },
      "work",
      "work",
      true,
      false,
    ],
    [
      "named account inheriting explicit channel enablement",
      { channels: { imessage: { enabled: true, accounts: { work: {} } } } },
      "work",
      "work",
      true,
      true,
    ],
    [
      "configured named account under a disabled channel",
      { channels: { imessage: { enabled: false, accounts: { work: { enabled: true } } } } },
      "work",
      "work",
      false,
      true,
    ],
    [
      "explicitly enabled configured default account",
      {
        channels: {
          imessage: { defaultAccount: "work", accounts: { work: { enabled: true } } },
        },
      },
      undefined,
      "work",
      true,
      true,
    ],
  ] as const)(
    "resolves independent enabled and configured state for %s",
    (_scenario, cfg, accountId, expectedAccountId, enabled, configured) => {
      expect(resolveIMessageAccount({ cfg: cfg as never, accountId })).toMatchObject({
        accountId: expectedAccountId,
        enabled,
        configured,
      });
    },
  );

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

  it.each([
    {
      name: "the implicit and explicitly configured default database",
      first: { cliPath: "imsg" },
      second: () => ({
        dbPath: path.join(process.env.HOME || os.homedir(), "Library", "Messages", "chat.db"),
      }),
    },
    {
      name: "a home-relative default database",
      first: { cliPath: "imsg" },
      second: () => ({ dbPath: "~/Library/Messages/chat.db" }),
    },
    {
      name: "a lexically equivalent default database",
      first: { cliPath: "imsg" },
      second: () => ({
        dbPath: `${process.env.HOME || os.homedir()}/Library/Messages/../Messages/chat.db`,
      }),
    },
    {
      name: "the same absolute executable with implicit and explicit databases",
      first: { cliPath: "/usr/local/bin/imsg" },
      second: () => ({
        cliPath: "/usr/local/bin/imsg",
        dbPath: path.join(process.env.HOME || os.homedir(), "Library", "Messages", "chat.db"),
      }),
    },
  ])("assigns one watcher and doctor warning for $name", ({ first, second }) => {
    const cfg = {
      channels: {
        imessage: {
          accounts: {
            primary: first,
            secondary: second(),
          },
        },
      },
    } as never;

    expect(
      resolveIMessageDuplicateSourceOwner({
        cfg,
        account: resolveIMessageAccount({ cfg, accountId: "primary" }),
      }),
    ).toBeUndefined();
    expect(
      resolveIMessageDuplicateSourceOwner({
        cfg,
        account: resolveIMessageAccount({ cfg, accountId: "secondary" }),
      }),
    ).toBe("primary");
    expect(collectIMessageDuplicateAccountSourceWarnings({ cfg })).toHaveLength(1);
  });

  it.each([
    {
      name: "different explicit local databases",
      first: { cliPath: "imsg", dbPath: "/tmp/imessage-primary.db" },
      second: { cliPath: "imsg", dbPath: "/tmp/imessage-secondary.db" },
    },
    {
      name: "different custom wrappers for the same remote database path",
      first: { cliPath: "/usr/local/bin/imsg-primary", dbPath: "/Users/bot/Messages/chat.db" },
      second: { cliPath: "/usr/local/bin/imsg-secondary", dbPath: "/Users/bot/Messages/chat.db" },
    },
    {
      name: "different auto-detected remote wrappers both named imsg",
      first: { cliPath: "/opt/host-a/imsg", dbPath: "/Users/bot/Library/Messages/chat.db" },
      second: { cliPath: "/opt/host-b/imsg", dbPath: "/Users/bot/Library/Messages/chat.db" },
    },
    {
      name: "an unverified bare command and a different absolute executable",
      first: { cliPath: "imsg" },
      second: { cliPath: "/usr/local/bin/imsg" },
    },
    {
      name: "different remote hosts behind the same wrapper",
      first: {
        cliPath: "/usr/local/bin/imsg-ssh",
        dbPath: "/Users/bot/Messages/chat.db",
        remoteHost: "bot@primary.example",
      },
      second: {
        cliPath: "/usr/local/bin/imsg-ssh",
        dbPath: "/Users/bot/Messages/chat.db",
        remoteHost: "bot@secondary.example",
      },
    },
    {
      name: "an explicitly remote and a local default binary",
      first: { cliPath: "imsg" },
      second: { cliPath: "imsg", remoteHost: "bot@remote.example" },
    },
  ])("preserves independent watchers for $name", ({ first, second }) => {
    const cfg = {
      channels: {
        imessage: {
          accounts: {
            primary: first,
            secondary: second,
          },
        },
      },
    } as never;

    for (const accountId of ["primary", "secondary"]) {
      expect(
        resolveIMessageDuplicateSourceOwner({
          cfg,
          account: resolveIMessageAccount({ cfg, accountId }),
        }),
      ).toBeUndefined();
    }
    expect(collectIMessageDuplicateAccountSourceWarnings({ cfg })).toEqual([]);
  });

  it("never lets an unconfigured account own or warn for the only startable watcher", () => {
    const cfg = {
      channels: {
        imessage: {
          accounts: {
            primary: {},
            secondary: { enabled: true, cliPath: "imsg" },
          },
        },
      },
    } as never;
    const unconfigured = resolveIMessageAccount({ cfg, accountId: "primary" });
    const configured = resolveIMessageAccount({ cfg, accountId: "secondary" });

    expect(unconfigured).toMatchObject({ enabled: true, configured: false });
    expect(configured).toMatchObject({ enabled: true, configured: true });
    expect(resolveIMessageDuplicateSourceOwner({ cfg, account: unconfigured })).toBeUndefined();
    expect(resolveIMessageDuplicateSourceOwner({ cfg, account: configured })).toBeUndefined();
    expect(collectIMessageDuplicateAccountSourceWarnings({ cfg })).toEqual([]);
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
            "swang430-gmail-com": { enabled: true },
            default: { enabled: true },
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
