// Signal tests cover doctor repair of account map keys that need canonicalization.
import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { SignalConfigSchema } from "../config-api.js";
import { legacyConfigRules, normalizeCompatibilityConfig } from "../doctor-contract-api.js";
import { listSignalAccountIds, resolveSignalAccount } from "./accounts.js";
import { signalDoctor } from "./doctor.js";

function signalConfig(entry: Record<string, unknown>): OpenClawConfig {
  return { channels: { signal: entry } } as never;
}

function repairSignal(entry: Record<string, unknown>) {
  const cfg = signalConfig(entry);
  const authored = structuredClone(cfg);
  const result = normalizeCompatibilityConfig({ cfg });
  // Doctor keeps the authored config beside the repaired candidate as diagnostic evidence, so the
  // repair must build a new map instead of editing the operator's parsed objects in place.
  expect(cfg).toEqual(authored);
  return {
    changes: result.changes,
    signal: expectDefined(result.config.channels?.signal, "repaired signal config"),
  };
}

const MOVE_CHANGE =
  /^Moved Signal account "(.+)" to its normalized key channels\.signal\.accounts\.([^.]+)\.$/;

/** Reported moves must name exactly the keys the repaired map dropped, and land on present ids. */
function expectChangesMatchMovedKeys(params: {
  changes: string[];
  authored: Record<string, unknown>;
  repaired: Record<string, unknown>;
}) {
  const reported = params.changes.map((change) =>
    expectDefined(MOVE_CHANGE.exec(change), `move change "${change}"`),
  );
  const byKey = (left: string | undefined, right: string | undefined) =>
    String(left).localeCompare(String(right));
  expect(reported.map((match) => match[1]).toSorted(byKey)).toEqual(
    Object.keys(params.authored)
      .filter((key) => !Object.hasOwn(params.repaired, key))
      .toSorted(byKey),
  );
  for (const match of reported) {
    expect(Object.hasOwn(params.repaired, expectDefined(match[2], "moved account id"))).toBe(true);
  }
}

const repairRule = legacyConfigRules.find(
  (rule) =>
    rule.path.join(".") === "channels.signal.accounts" &&
    rule.message.includes("normalized account id"),
);
const collisionRule = legacyConfigRules.find(
  (rule) =>
    rule.path.join(".") === "channels.signal.accounts" &&
    rule.message.includes("same normalized account id"),
);

describe("signal account key repair", () => {
  it("moves a unique authored key and preserves the whole account entry", () => {
    const accounts = {
      "Work Phone": {
        account: "+15555550123",
        name: "Work",
        transport: { kind: "external-native", url: "http://127.0.0.1:9101" },
        dmPolicy: "allowlist",
        allowFrom: ["+15555550124"],
        contextVisibility: "allowlist",
        textChunkLimit: 123,
        aliases: { boss: "+15555550124" },
        groups: { "*": { tools: { allow: ["read"] } } },
        unknownFutureKey: { nested: [0, false, { opaque: "${SIGNAL_OPAQUE_REF}" }] },
      },
    };
    const authored = structuredClone(accounts);

    const repaired = repairSignal({ accounts });

    expect(repairRule?.match?.(accounts, {})).toBe(true);
    expect(collisionRule?.match?.(accounts, {})).toBe(false);
    expect(repaired.changes).toEqual([
      'Moved Signal account "Work Phone" to its normalized key channels.signal.accounts.work-phone.',
    ]);
    expect(repaired.signal.accounts).toEqual({ "work-phone": authored["Work Phone"] });
    // The repaired map only helps if it survives the config writer's serialize and reread.
    const persisted = JSON.stringify(repaired.signal.accounts);
    expect(JSON.parse(persisted)).toEqual({ "work-phone": authored["Work Phone"] });
  });

  it("moves every independent key in one run and reports exactly what moved", () => {
    const accounts = {
      "Work Phone": { name: "Work", textChunkLimit: 123 },
      "Home.Phone": { name: "Home", allowFrom: ["+15555550124"] },
      "team-phone": { name: "Team" },
    };
    const authored = structuredClone(accounts);

    const repaired = repairSignal({ accounts });

    expect(repaired.signal.accounts).toEqual({
      "work-phone": authored["Work Phone"],
      "home-phone": authored["Home.Phone"],
      "team-phone": authored["team-phone"],
    });
    expect(repaired.changes).toEqual([
      'Moved Signal account "Work Phone" to its normalized key channels.signal.accounts.work-phone.',
      'Moved Signal account "Home.Phone" to its normalized key channels.signal.accounts.home-phone.',
    ]);
    expectChangesMatchMovedKeys({
      changes: repaired.changes,
      authored,
      repaired: expectDefined(repaired.signal.accounts, "repaired accounts"),
    });
  });

  it("repairs an unrelated key while leaving colliding keys exactly as authored", () => {
    const accounts = {
      "Work Phone": { name: "Alias A" },
      "work.phone": { name: "Alias B" },
      "Home Phone": { name: "Home", textChunkLimit: 321 },
    };
    const authored = structuredClone(accounts);

    const repaired = repairSignal({ accounts });

    expect(repairRule?.match?.(accounts, {})).toBe(true);
    expect(collisionRule?.match?.(accounts, {})).toBe(true);
    expect(repaired.signal.accounts).toEqual({
      "Work Phone": authored["Work Phone"],
      "work.phone": authored["work.phone"],
      "home-phone": authored["Home Phone"],
    });
    expect(repaired.changes).toEqual([
      'Moved Signal account "Home Phone" to its normalized key channels.signal.accounts.home-phone.',
    ]);
    expectChangesMatchMovedKeys({
      changes: repaired.changes,
      authored,
      repaired: expectDefined(repaired.signal.accounts, "repaired accounts"),
    });
  });

  it("makes the listed account resolvable only after the repair", () => {
    const accounts = {
      "Work Phone": {
        account: "+15555550123",
        transport: { kind: "external-native", url: "http://127.0.0.1:9101" },
      },
    };
    const cfg = signalConfig({ accounts });

    expect(listSignalAccountIds(cfg)).toEqual(["work-phone"]);
    const before = resolveSignalAccount({ cfg, accountId: "work-phone" });
    expect(before.configured).toBe(false);
    expect(before.transport.kind).toBe("managed-native");

    const after = resolveSignalAccount({
      cfg: normalizeCompatibilityConfig({ cfg }).config,
      accountId: "work-phone",
    });
    expect(after.configured).toBe(true);
    expect(after.baseUrl).toBe("http://127.0.0.1:9101");
  });

  it.each([
    {
      shape: "an exact winner",
      accounts: {
        "work-phone": { transport: { kind: "external-native", url: "http://127.0.0.1:9101" } },
        "work.phone": { transport: { kind: "external-native", url: "http://127.0.0.1:9102" } },
      },
      reportedKeys: '"work-phone", "work.phone"',
    },
    {
      shape: "a case-folded winner",
      accounts: {
        "WORK-PHONE": { transport: { kind: "external-native", url: "http://127.0.0.1:9101" } },
        "work.phone": { transport: { kind: "external-native", url: "http://127.0.0.1:9102" } },
      },
      reportedKeys: '"WORK-PHONE", "work.phone"',
    },
    {
      shape: "two authored keys for one id",
      accounts: {
        "work.phone": { transport: { kind: "external-native", url: "http://127.0.0.1:9101" } },
        "Work Phone": { transport: { kind: "external-native", url: "http://127.0.0.1:9102" } },
      },
      reportedKeys: '"work.phone", "Work Phone"',
    },
  ])("keeps colliding keys as authored and reports them: $shape", ({ accounts, reportedKeys }) => {
    const authored = structuredClone(accounts);

    const repaired = repairSignal({ accounts });

    expect(collisionRule?.match?.(accounts, {})).toBe(true);
    expect(repairRule?.match?.(accounts, {})).toBe(false);
    expect(repaired.changes).toEqual([]);
    expect(repaired.signal.accounts).toEqual(authored);
    expect(
      signalDoctor.collectPreviewWarnings?.({
        cfg: signalConfig({ accounts }),
        doctorFixCommand: "openclaw doctor --fix",
      }),
    ).toEqual([
      `- channels.signal.accounts: ${reportedKeys} resolve to account id "work-phone". Doctor keeps them as authored; only an existing exact or case-insensitive matching key remains selected. Rename them so one key owns the account.`,
    ]);
  });

  it("reports nothing and changes nothing when every key is already normalized", () => {
    const accounts = { "work-phone": { account: "+15555550123" }, default: {} };

    const repaired = repairSignal({ accounts });

    expect(repairRule?.match?.(accounts, {})).toBe(false);
    expect(collisionRule?.match?.(accounts, {})).toBe(false);
    expect(repaired.changes).toEqual([]);
    expect(
      signalDoctor.collectPreviewWarnings?.({
        cfg: signalConfig({ accounts }),
        doctorFixCommand: "openclaw doctor --fix",
      }),
    ).toEqual([]);
  });

  it("reports no further changes on a second doctor run", () => {
    const cfg = signalConfig({ accounts: { "Work Phone": { account: "+15555550123" } } });

    const first = normalizeCompatibilityConfig({ cfg });
    const second = normalizeCompatibilityConfig({ cfg: first.config });

    expect(first.changes).toHaveLength(1);
    expect(second.changes).toEqual([]);
    expect(second.config).toEqual(first.config);
  });

  it("keeps the effective account number and root transport across a default-key repair", () => {
    const cfg = signalConfig({
      account: "+15555550100",
      transport: { kind: "container", url: "http://signal-container:8080" },
      accounts: { "Default.": { account: "", name: "Primary" } },
    });

    expect(SignalConfigSchema.safeParse(cfg.channels?.signal).success).toBe(true);
    const before = resolveSignalAccount({ cfg, accountId: "default" });
    const repaired = normalizeCompatibilityConfig({ cfg });
    const signal = expectDefined(repaired.config.channels?.signal, "repaired signal config");
    const after = resolveSignalAccount({ cfg: repaired.config, accountId: "default" });

    expect(signal.accounts).toEqual({ default: { name: "Primary" } });
    expect(signal.account).toBe("+15555550100");
    expect(signal.transport).toEqual({ kind: "container", url: "http://signal-container:8080" });
    expect(after.config.account).toBe(before.config.account);
    expect(after.transport).toEqual(before.transport);
    expect(after.configured).toBe(true);
    expect(SignalConfigSchema.safeParse(signal).success).toBe(true);
  });

  it("drops a whitespace-only default account override like an empty one", () => {
    const repaired = repairSignal({
      account: "+15555550100",
      accounts: { "Default.": { account: "   ", name: "Primary" } },
    });

    expect(repaired.signal.accounts).toEqual({ default: { name: "Primary" } });
  });

  it.each([
    { shape: "a number", account: 42 },
    { shape: "null", account: null },
    { shape: "false", account: false },
    { shape: "an object", account: { number: "+15555550123" } },
  ])("keeps a non-string default identity for the validator: $shape", ({ account }) => {
    const repaired = repairSignal({
      account: "+15555550100",
      accounts: { "Default.": { account, name: "Primary" } },
    });

    expect(repaired.signal.accounts).toEqual({ default: { account, name: "Primary" } });
  });

  it("keeps an empty account override on a named account beside a root number", () => {
    const repaired = repairSignal({
      account: "+15555550100",
      accounts: { "Work Phone": { account: "", name: "Work" } },
    });

    expect(repaired.signal.accounts).toEqual({ "work-phone": { account: "", name: "Work" } });
  });

  it("keeps an empty account override when no root number can be inherited", () => {
    const repaired = repairSignal({ accounts: { "Default.": { account: "", name: "Work" } } });

    expect(repaired.signal.accounts).toEqual({ default: { account: "", name: "Work" } });
  });

  it("repairs a config that the Signal schema rejects", () => {
    const entry = {
      dmPolicy: "open",
      allowFrom: ["+15555550123"],
      accounts: { "Work Phone": { account: "+15555550124" } },
    };

    expect(SignalConfigSchema.safeParse(entry).success).toBe(false);
    expect(repairSignal(entry).signal.accounts).toEqual({
      "work-phone": { account: "+15555550124" },
    });
  });
});
