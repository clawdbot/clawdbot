// Signal tests cover accounts plugin behavior.
import { describe, expect, it } from "vitest";
import {
  listSignalAccountIds,
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
  resolveSignalAccountConfig,
  resolveSignalReplyToMode,
} from "./accounts.js";

describe("resolveSignalAccount", () => {
  it("resolves an omitted transport to managed native defaults", () => {
    const resolved = resolveSignalAccount({ cfg: { channels: { signal: {} } } as never });

    expect(resolved.transport).toEqual({
      kind: "managed-native",
      baseUrl: "http://127.0.0.1:8080",
      cliPath: "signal-cli",
      httpHost: "127.0.0.1",
      httpPort: 8080,
      startupTimeoutMs: 30_000,
    });
  });

  it.each([
    {
      name: "uses a managed native connection URL independently from its daemon bind",
      transport: {
        kind: "managed-native",
        url: "http://127.0.0.1:8181",
        httpHost: "0.0.0.0",
        httpPort: 8181,
      },
      expected: { baseUrl: "http://127.0.0.1:8181", httpHost: "0.0.0.0", httpPort: 8181 },
    },
    {
      name: "formats an IPv6 managed native bind as a valid connection URL",
      transport: { kind: "managed-native", httpHost: "::1", httpPort: 8181 },
      expected: { baseUrl: "http://[::1]:8181", httpHost: "::1", httpPort: 8181 },
    },
    {
      name: "canonicalizes a bracketed IPv6 managed native bind",
      transport: { kind: "managed-native", httpHost: "[::1]", httpPort: 8181 },
      expected: { baseUrl: "http://[::1]:8181", httpHost: "::1", httpPort: 8181 },
    },
    {
      name: "does not reserve a managed transport's own implicit connection endpoint",
      transport: {
        kind: "managed-native",
        url: "http://127.0.0.1:8080",
        httpHost: "0.0.0.0",
      },
      expected: { baseUrl: "http://127.0.0.1:8080", httpHost: "0.0.0.0", httpPort: 8080 },
    },
    {
      name: "preserves a same-port connection URL on a different specific bind address",
      transport: {
        kind: "managed-native",
        url: "http://127.0.0.1:8080",
        httpHost: "127.0.0.2",
      },
      expected: { baseUrl: "http://127.0.0.1:8080", httpHost: "127.0.0.2", httpPort: 8081 },
    },
  ])("$name", ({ transport, expected }) => {
    const cfg = { channels: { signal: { transport } } } as never;

    expect(resolveSignalAccount({ cfg }).transport).toMatchObject({
      kind: "managed-native",
      ...expected,
    });
  });

  it("does not inherit the default account transport into named accounts", () => {
    const cfg = {
      channels: {
        signal: {
          transport: { kind: "container", url: "http://default-container:8080" },
          accounts: { work: { account: "+15555550123" } },
        },
      },
    } as never;

    expect(resolveSignalAccount({ cfg }).transport).toEqual({
      kind: "container",
      baseUrl: "http://default-container:8080",
    });
    expect(resolveSignalAccount({ cfg, accountId: "work" }).transport).toMatchObject({
      kind: "managed-native",
      baseUrl: "http://127.0.0.1:8080",
    });
  });

  it("keeps the root transport authoritative over accounts.default", () => {
    const cfg = {
      channels: {
        signal: {
          transport: { kind: "external-native", url: "http://canonical-native:8181" },
          accounts: {
            default: {
              account: "+15555550123",
              transport: { kind: "container", url: "http://stale-container:8080" },
            },
          },
        },
      },
    } as never;

    expect(resolveSignalAccount({ cfg, accountId: "default" }).transport).toEqual({
      kind: "external-native",
      baseUrl: "http://canonical-native:8181",
    });
  });

  it("allocates distinct default ports across managed native accounts", () => {
    const cfg = {
      channels: {
        signal: {
          accounts: {
            personal: { account: "+15555550123", transport: { kind: "managed-native" } },
            work: { account: "+15555550124", transport: { kind: "managed-native" } },
          },
        },
      },
    } as never;

    expect(resolveSignalAccount({ cfg, accountId: "personal" }).transport).toMatchObject({
      kind: "managed-native",
      httpPort: 8080,
    });
    expect(resolveSignalAccount({ cfg, accountId: "work" }).transport).toMatchObject({
      kind: "managed-native",
      httpPort: 8081,
    });
  });

  it.each([
    {
      name: "matches case-preserving account keys while allocating implicit ports",
      accounts: {
        alpha: {
          account: "+15555550123",
          transport: { kind: "managed-native", httpPort: 8080 },
        },
        Ops: { account: "+15555550124", transport: { kind: "managed-native" } },
      },
      accountId: "Ops",
      httpPort: 8081,
    },
    {
      name: "does not let a disabled account block an active managed port",
      accounts: {
        dormant: {
          enabled: false,
          account: "+15555550123",
          transport: { kind: "managed-native", httpPort: 8181 },
        },
        work: {
          account: "+15555550124",
          transport: { kind: "managed-native", httpPort: 8181 },
        },
      },
      accountId: "work",
      httpPort: 8181,
    },
    {
      name: "does not reserve an implicit managed port for a disabled account",
      accounts: {
        dormant: {
          enabled: false,
          account: "+15555550123",
          transport: { kind: "managed-native" },
        },
        work: { account: "+15555550124", transport: { kind: "managed-native" } },
      },
      accountId: "work",
      httpPort: 8080,
    },
    {
      name: "does not let an unconfigured placeholder consume a managed port",
      accounts: {
        placeholder: { enabled: false },
        work: { account: "+15555550124", transport: { kind: "managed-native" } },
      },
      accountId: "work",
      httpPort: 8080,
    },
    {
      name: "reserves managed bind and local connection ports for implicit accounts",
      accounts: {
        proxy: {
          account: "+15555550123",
          transport: {
            kind: "managed-native",
            url: "http://localhost:8080",
            httpPort: 8181,
          },
        },
        work: { account: "+15555550124", transport: { kind: "managed-native" } },
      },
      accountId: "work",
      httpPort: 8081,
    },
  ])("$name", ({ accounts, accountId, httpPort }) => {
    const cfg = { channels: { signal: { accounts } } } as never;

    expect(resolveSignalAccount({ cfg, accountId }).transport).toMatchObject({
      kind: "managed-native",
      httpPort,
    });
  });

  it.each([
    {
      name: "rejects duplicate explicit managed native ports",
      accounts: {
        personal: {
          account: "+15555550123",
          transport: { kind: "managed-native", httpPort: 8181 },
        },
        work: {
          account: "+15555550124",
          transport: { kind: "managed-native", httpPort: 8181 },
        },
      },
      message: 'Signal managed native accounts "work" and "personal" both bind port 8181.',
    },
    {
      name: "rejects an explicit managed port used by a local external endpoint",
      accounts: {
        proxy: {
          account: "+15555550123",
          transport: { kind: "container", url: "http://localhost:8181" },
        },
        work: {
          account: "+15555550124",
          transport: { kind: "managed-native", httpPort: 8181 },
        },
      },
      message:
        'Signal managed native account "work" binds port 8181, which conflicts with account "proxy" local transport endpoint.',
    },
  ])("$name", ({ accounts, message }) => {
    const cfg = { channels: { signal: { accounts } } } as never;

    expect(() => resolveSignalAccount({ cfg, accountId: "work" })).toThrow(message);
  });

  it("rejects an explicit managed port used by its own independent local endpoint", () => {
    const cfg = {
      channels: {
        signal: {
          account: "+15555550123",
          transport: {
            kind: "managed-native",
            url: "https://127.0.0.1:8181",
            httpPort: 8181,
          },
        },
      },
    } as never;

    expect(() => resolveSignalAccount({ cfg })).toThrow(
      'Signal managed native account "default" binds port 8181, which conflicts with its local transport endpoint.',
    );
  });

  it("keeps an implicit managed connection URL aligned with its allocated bind", () => {
    const cfg = {
      channels: {
        signal: {
          transport: { kind: "managed-native", httpPort: 8080 },
          accounts: {
            work: {
              account: "+15555550124",
              transport: {
                kind: "managed-native",
                url: "http://127.0.0.1:8080",
                httpHost: "0.0.0.0",
              },
            },
          },
        },
      },
    } as never;

    expect(resolveSignalAccount({ cfg, accountId: "work" }).transport).toMatchObject({
      kind: "managed-native",
      baseUrl: "http://127.0.0.1:8081",
      httpHost: "0.0.0.0",
      httpPort: 8081,
    });
  });

  it("preserves top-level default account when named accounts are configured", () => {
    const cfg = {
      channels: {
        signal: {
          account: "+15555550123",
          accounts: { work: { enabled: false } },
        },
      },
    } as never;

    expect(listSignalAccountIds(cfg)).toEqual(["default", "work"]);
    expect(resolveDefaultSignalAccountId(cfg)).toBe("default");
    expect(resolveSignalAccount({ cfg }).config.account).toBe("+15555550123");
  });

  it("deduplicates a case-preserving default account from the implicit root transport", () => {
    const cfg = {
      channels: {
        signal: {
          transport: { kind: "container", url: "http://signal-container:8080" },
          accounts: { Default: { account: "+15555550123" } },
        },
      },
    } as never;

    expect(listSignalAccountIds(cfg)).toEqual(["default"]);
    expect(resolveSignalAccount({ cfg }).config.account).toBe("+15555550123");
  });

  it("does not treat accountUuid as an implicit configured default account", () => {
    const cfg = {
      channels: {
        signal: {
          accountUuid: "123e4567-e89b-12d3-a456-426614174000",
          accounts: { work: { account: "+15555550123" } },
        },
      },
    } as never;

    expect(listSignalAccountIds(cfg)).toEqual(["work"]);
    expect(resolveSignalAccount({ cfg, accountId: "default" }).configured).toBe(false);
    expect(resolveSignalAccount({ cfg }).accountId).toBe("work");
  });

  it("keeps accountUuid supplemental when no E.164 account or transport exists", () => {
    const cfg = {
      channels: {
        signal: { accountUuid: "123e4567-e89b-12d3-a456-426614174000" },
      },
    } as never;

    expect(listSignalAccountIds(cfg)).toEqual(["default"]);
    expect(resolveSignalAccount({ cfg }).configured).toBe(false);
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
                transport: { kind: "external-native", url: "http://127.0.0.1:9999" },
              },
            },
          },
        },
      } as never,
    });

    expect(resolved.accountId).toBe("work");
    expect(resolved.name).toBe("Work");
    expect(resolved.baseUrl).toBe("http://127.0.0.1:9999");
    expect(resolved.transport).toEqual({
      kind: "external-native",
      baseUrl: "http://127.0.0.1:9999",
    });
    expect(resolved.config.account).toBe("+15555550123");
    expect(resolved.configured).toBe(true);
  });
});

function signalCfgWithAccounts(accounts: Record<string, unknown>) {
  return { channels: { signal: { accounts } } } as never;
}

function externalTransport(port: number) {
  return { transport: { kind: "external-native", url: `http://127.0.0.1:${port}` } };
}

describe("signal account key resolution", () => {
  it("resolves a config key listed under its normalized account id", () => {
    const cfg = signalCfgWithAccounts({
      "Work Phone": { account: "+15555550123", ...externalTransport(9101) },
    });

    expect(listSignalAccountIds(cfg)).toEqual(["work-phone"]);
    const resolved = resolveSignalAccount({ cfg, accountId: "work-phone" });
    expect(resolved.configured).toBe(true);
    expect(resolved.baseUrl).toBe("http://127.0.0.1:9101");
  });

  it("applies a raw-key account replyToMode under its normalized id", () => {
    const cfg = {
      channels: {
        signal: { replyToMode: "off", accounts: { "Work Phone": { replyToMode: "first" } } },
      },
    } as never;

    expect(resolveSignalReplyToMode({ cfg, accountId: "work-phone" })).toBe("first");
  });

  it.each([
    {
      order: "alias first",
      accounts: { "work.phone": externalTransport(9101), "WORK-PHONE": externalTransport(9102) },
    },
    {
      order: "case-folded key first",
      accounts: { "WORK-PHONE": externalTransport(9102), "work.phone": externalTransport(9101) },
    },
  ])("keeps a case-folded key ahead of a canonical alias with $order", ({ accounts }) => {
    const cfg = signalCfgWithAccounts(accounts);

    expect(listSignalAccountIds(cfg)).toEqual(["work-phone"]);
    expect(resolveSignalAccount({ cfg, accountId: "WORK-PHONE" }).baseUrl).toBe(
      "http://127.0.0.1:9102",
    );
  });

  it("prefers an exact key, then a case-folded key, then a canonical alias", () => {
    const alias = { "work.phone": externalTransport(9101) };
    const caseFolded = { "WORK-PHONE": externalTransport(9102) };
    const exact = { "work-phone": externalTransport(9103) };

    const resolveBaseUrl = (accounts: Record<string, unknown>) =>
      resolveSignalAccount({ cfg: signalCfgWithAccounts(accounts), accountId: "work-phone" })
        .baseUrl;

    expect(resolveBaseUrl({ ...alias, ...caseFolded, ...exact })).toBe("http://127.0.0.1:9103");
    expect(resolveBaseUrl({ ...alias, ...caseFolded })).toBe("http://127.0.0.1:9102");
    expect(resolveBaseUrl(alias)).toBe("http://127.0.0.1:9101");
  });

  it.each([
    {
      order: "dotted key first",
      accounts: { "work.phone": externalTransport(9101), "Work Phone": externalTransport(9102) },
      expected: "http://127.0.0.1:9101",
    },
    {
      order: "spaced key first",
      accounts: { "Work Phone": externalTransport(9102), "work.phone": externalTransport(9101) },
      expected: "http://127.0.0.1:9102",
    },
  ])(
    // Policy: with no exact and no case-folded key, the first alias in object order wins.
    // Object order is the config file order, so the same file always picks the same account.
    "uses the first alias in object order with $order",
    ({ accounts, expected }) => {
      const cfg = signalCfgWithAccounts(accounts);

      expect(resolveSignalAccount({ cfg, accountId: "work-phone" }).baseUrl).toBe(expected);
    },
  );

  it("does not resolve an empty account id to the default account", () => {
    const cfg = signalCfgWithAccounts({ default: { account: "+15555550100" } });

    expect(resolveSignalAccountConfig(cfg, "").account).toBeUndefined();
    expect(resolveSignalAccountConfig(cfg, "default").account).toBe("+15555550100");
  });

  it("does not resolve an id whose canonical form is a blocked object key", () => {
    const cfg = signalCfgWithAccounts({
      "__PROTO__!": { account: "+15555550199" },
      default: { account: "+15555550100" },
    });

    expect(resolveSignalAccountConfig(cfg, "__proto__").account).toBeUndefined();
  });
});
