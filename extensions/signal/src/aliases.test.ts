import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
// Signal tests cover alias target resolution behavior.
import { describe, expect, it } from "vitest";
import { listSignalAliasDirectoryEntries, resolveSignalTarget } from "./aliases.js";

describe("resolveSignalTarget aliases", () => {
  it("resolves top-level DM aliases to canonical targets", () => {
    const cfg = {
      channels: {
        signal: {
          aliases: {
            home: "+15551234567",
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveSignalTarget({ cfg, input: "signal:home" })).toEqual({
      kind: "user",
      to: "+15551234567",
      alias: "home",
      source: "alias",
    });
  });

  it("resolves account aliases after merging top-level aliases", () => {
    const cfg = {
      channels: {
        signal: {
          aliases: {
            home: "+15551234567",
          },
          accounts: {
            work: {
              aliases: {
                ops: "signal:group:VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg=",
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveSignalTarget({ cfg, accountId: "work", input: "ops" })).toEqual({
      kind: "group",
      to: "group:VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg=",
      alias: "ops",
      source: "alias",
    });
    expect(resolveSignalTarget({ cfg, accountId: "work", input: "home" })?.to).toBe("+15551234567");
  });

  it("rejects recursive aliases before delivery", () => {
    const cfg = {
      channels: {
        signal: {
          aliases: {
            home: "signal:me",
            me: "home",
          },
        },
      },
    } as OpenClawConfig;

    expect(() => resolveSignalTarget({ cfg, input: "home" })).toThrow(
      'Signal alias "home" resolves recursively through "home".',
    );
  });

  it("rejects aliases whose final value is not a Signal target", () => {
    const cfg = {
      channels: {
        signal: {
          aliases: {
            jane: "not a target",
          },
        },
      },
    } as OpenClawConfig;

    expect(() => resolveSignalTarget({ cfg, input: "jane" })).toThrow(
      'Signal alias "jane" must point to an E.164 number, uuid:<id>, username:<name>, or group:<id>.',
    );
  });

  it("treats target-looking alias values as terminal targets before alias chaining", () => {
    const cfg = {
      channels: {
        signal: {
          aliases: {
            home: "+15551230000",
            "+15551230000": "+15559990000",
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveSignalTarget({ cfg, input: "home" })).toEqual({
      kind: "user",
      to: "+15551230000",
      alias: "home",
      source: "alias",
    });
  });

  it("resolves own prototype-shaped aliases without inheriting prototype keys", () => {
    const cfg = {
      channels: {
        signal: {
          aliases: {
            constructor: "+15551234567",
            toString: "group:VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg=",
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveSignalTarget({ cfg, input: "constructor" })).toEqual({
      kind: "user",
      to: "+15551234567",
      alias: "constructor",
      source: "alias",
    });
    expect(resolveSignalTarget({ cfg, input: "toString" })).toEqual({
      kind: "group",
      to: "group:VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg=",
      alias: "tostring",
      source: "alias",
    });

    const ordinaryCfg = {
      channels: {
        signal: {
          aliases: {
            me: "+15551234567",
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveSignalTarget({ cfg: ordinaryCfg, input: "constructor" })).toBeNull();
  });
});

describe("resolveSignalTarget", () => {
  it("resolves aliases and raw targets through the same canonical parser", () => {
    const cfg = {
      channels: {
        signal: {
          aliases: {
            me: "uuid:123E4567-E89B-12D3-A456-426614174000",
            "+15551230000": "+15559990000",
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveSignalTarget({ cfg, input: "signal:me" })).toEqual({
      kind: "user",
      to: "123e4567-e89b-12d3-a456-426614174000",
      source: "alias",
      alias: "me",
    });
    expect(
      resolveSignalTarget({ cfg, input: "uuid:123E4567-E89B-12D3-A456-426614174000" }),
    ).toEqual({
      kind: "user",
      to: "123e4567-e89b-12d3-a456-426614174000",
      source: "raw",
    });
    expect(resolveSignalTarget({ cfg, input: "+15551230000" })).toEqual({
      kind: "user",
      to: "+15551230000",
      source: "raw",
    });
  });
});

describe("listSignalAliasDirectoryEntries", () => {
  it("lists alias-backed peers and groups with alias display names", () => {
    const cfg = {
      channels: {
        signal: {
          aliases: {
            me: "+15551234567",
            ops: "group:VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg=",
          },
        },
      },
    } as OpenClawConfig;

    expect(listSignalAliasDirectoryEntries({ cfg, kind: "user" })).toEqual([
      { kind: "user", id: "+15551234567", name: "me" },
    ]);
    expect(listSignalAliasDirectoryEntries({ cfg, kind: "user", query: "1555" })).toEqual([
      { kind: "user", id: "+15551234567", name: "me" },
    ]);
    expect(listSignalAliasDirectoryEntries({ cfg, kind: "group" })).toEqual([
      {
        kind: "group",
        id: "group:VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg=",
        name: "ops",
      },
    ]);
  });

  it("lists aliases that resolve through another alias", () => {
    const cfg = {
      channels: {
        signal: {
          aliases: {
            me: "+15551234567",
            home: "signal:me",
          },
        },
      },
    } as OpenClawConfig;

    expect(listSignalAliasDirectoryEntries({ cfg, kind: "user" })).toEqual([
      { kind: "user", id: "+15551234567", name: "me" },
      { kind: "user", id: "+15551234567", name: "home" },
    ]);
  });

  it("does not let fuzzy peer matches shadow exact group aliases", () => {
    const cfg = {
      channels: {
        signal: {
          aliases: {
            ops: "group:VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg=",
            "ops-dm": "+15551234567",
          },
        },
      },
    } as OpenClawConfig;

    expect(listSignalAliasDirectoryEntries({ cfg, kind: "user", query: "ops" })).toEqual([]);
    expect(listSignalAliasDirectoryEntries({ cfg, kind: "group", query: "ops" })).toEqual([
      {
        kind: "group",
        id: "group:VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg=",
        name: "ops",
      },
    ]);
  });

  it("fails invalid exact aliases instead of falling through to fuzzy matches", () => {
    const cfg = {
      channels: {
        signal: {
          aliases: {
            ops: "not-a-signal-target",
            "ops-dm": "+15551234567",
          },
        },
      },
    } as OpenClawConfig;

    expect(() => listSignalAliasDirectoryEntries({ cfg, kind: "user", query: "ops" })).toThrow(
      'Signal alias "ops" must point to an E.164 number, uuid:<id>, username:<name>, or group:<id>.',
    );
  });
});
