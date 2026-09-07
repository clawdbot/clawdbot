// Signal tests cover the setup guard on account-map keys and where a named add's promotion lands.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  type ChannelSetupAdapter,
  moveSingleAccountChannelSectionToDefaultAccount,
} from "openclaw/plugin-sdk/setup";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeCompatibilityConfig } from "../doctor-contract-api.js";
import { resolveSignalAccount } from "./accounts.js";
import { signalSetupAdapter, signalSetupContract } from "./setup-core.js";

const detectSignalTransportMock = vi.hoisted(() => vi.fn());

vi.mock("./setup-transport.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./setup-transport.js")>();
  return { ...actual, detectSignalTransport: detectSignalTransportMock };
});

const ROOT_NUMBER = "+15555550100";

const externalNativeInput = {
  signalTransport: "external-native" as const,
  httpUrl: "http://127.0.0.1:9299",
};

/** A root number beside the given account map, the shape a named add promotes from. */
function rootNumberConfig(signal: {
  accounts: Record<string, { account?: string; name?: string }>;
  defaultAccount?: string;
  transport?: { kind: "container"; url: string };
}): OpenClawConfig {
  return { channels: { signal: { account: ROOT_NUMBER, ...signal } } };
}

/** Setup results are only useful once they survive the config writer's serialize and reread. */
function reload(cfg: OpenClawConfig | undefined): OpenClawConfig {
  const persisted = JSON.stringify(cfg ?? {});
  return JSON.parse(persisted) as OpenClawConfig;
}

/**
 * A named add promotes single-account root keys into the map before the adapter writes
 * (src/channels/plugins/account-config-mutation.ts:141-152); calling the adapter alone skips it.
 * The CLI hands the promotion the setup contract, not the adapter (account-config-mutation.ts:69
 * and :145), so the contract has to forward Signal's declarations for the writer to see them.
 */
function addNamedAccount(cfg: OpenClawConfig, accountId: string) {
  const promoted = moveSingleAccountChannelSectionToDefaultAccount({
    cfg,
    channelKey: "signal",
    setupSurface: signalSetupContract as ChannelSetupAdapter,
  });
  return signalSetupAdapter.applyAccountConfig?.({
    cfg: promoted,
    accountId,
    input: externalNativeInput,
  });
}

describe("signalSetupAdapter account keys", () => {
  beforeEach(() => {
    detectSignalTransportMock.mockReset();
  });

  it("adds a named account when promotion lands on the exact key beside the case variant listed first", () => {
    const cfg = rootNumberConfig({
      accounts: { Default: { name: "Alias" }, default: { name: "Canon" } },
    });
    const authored = structuredClone(cfg);

    // The promotion resolves its key with the lookup Signal declares (accountEntryLookup in
    // setup-core.ts, applied by resolveExistingAccountKey in src/channels/plugins/setup-helpers.ts),
    // so the exact key wins over the case variant listed first, the entry every reader takes
    // (src/routing/account-lookup.ts:15-17). Before this change the writer took the first key
    // normalizing to "default", the shadowed variant, and this add was refused with a rename
    // pointer.
    expect(
      signalSetupAdapter.validateInput?.({ cfg, accountId: "work", input: externalNativeInput }),
    ).toBeNull();
    const reloaded = reload(addNamedAccount(cfg, "work"));
    const accounts = reloaded.channels?.signal?.accounts;

    expect(Object.keys(accounts ?? {})).toEqual(["Default", "default", "work"]);
    expect(accounts?.default).toEqual({ name: "Canon", account: ROOT_NUMBER });
    expect(accounts?.Default).toEqual(authored.channels?.signal?.accounts?.Default);
    expect(reloaded.channels?.signal?.account).toBeUndefined();
    expect(resolveSignalAccount({ cfg: reloaded, accountId: "default" }).config.account).toBe(
      ROOT_NUMBER,
    );
  });

  it("adds a named account when promotion lands on the case-folded winner beside its stranded twin", () => {
    const cfg = rootNumberConfig({
      transport: { kind: "container", url: "http://signal-container:8080" },
      accounts: { Default: { name: "Canon" }, "Default.": { name: "Alias" } },
    });
    const authored = structuredClone(cfg);

    // With no exact key a reader selects "Default" by case fold
    // (src/routing/account-lookup.ts:18-22), so the promotion into it lands where every reader
    // looks. Comparing the written key with the id instead would refuse this add and call the
    // selected key one the account lookup does not select. The exact key listed first beside its
    // twin is covered by setup-core.test.ts ("adds a named account when promotion lands on the
    // selected key beside its stranded twin").
    expect(
      signalSetupAdapter.validateInput?.({ cfg, accountId: "work", input: externalNativeInput }),
    ).toBeNull();
    const reloaded = reload(addNamedAccount(cfg, "work"));
    const accounts = reloaded.channels?.signal?.accounts;

    expect(Object.keys(accounts ?? {})).toEqual(["Default", "Default.", "work"]);
    expect(resolveSignalAccount({ cfg: reloaded, accountId: "default" }).config.account).toBe(
      ROOT_NUMBER,
    );
    expect(accounts?.["Default."]).toEqual(authored.channels?.signal?.accounts?.["Default."]);
  });

  it("allows an exact named write beside the case variant a reader selects for it", () => {
    const cfg = rootNumberConfig({
      accounts: { "Work-Phone": { account: "+15555550123", name: "Winner" } },
    });

    // The exact "work-phone" entry shadows "Work-Phone" once written, the disclosed shape left to
    // the operator. Only the promotion picks a raw key, so the check does not refuse this write.
    expect(
      signalSetupAdapter.validateInput?.({
        cfg,
        accountId: "work-phone",
        input: externalNativeInput,
      }),
    ).toBeNull();
  });

  it("adds a named account when promotion lands on the case-folded winner listed after its alias", () => {
    const cfg = rootNumberConfig({
      accounts: { "Default.": { name: "Alias" }, Default: { name: "Canon" } },
    });
    const authored = structuredClone(cfg);

    // Under the lookup Signal declares (accountEntryLookup in setup-core.ts) the promotion takes
    // the exact key, else the first key whose lowercase is the id, the resolver's own rule
    // (src/routing/account-lookup.ts:18-22), so the alias listed first is passed over. Before this
    // change the writer took the first key normalizing to "default", the alias, and this add was
    // refused with a rename pointer.
    expect(
      signalSetupAdapter.validateInput?.({ cfg, accountId: "work", input: externalNativeInput }),
    ).toBeNull();
    const reloaded = reload(addNamedAccount(cfg, "work"));
    const accounts = reloaded.channels?.signal?.accounts;

    expect(Object.keys(accounts ?? {})).toEqual(["Default.", "Default", "work"]);
    expect(accounts?.Default).toEqual({ name: "Canon", account: ROOT_NUMBER });
    expect(accounts?.["Default."]).toEqual(authored.channels?.signal?.accounts?.["Default."]);
    expect(reloaded.channels?.signal?.account).toBeUndefined();
    expect(resolveSignalAccount({ cfg: reloaded, accountId: "default" }).config.account).toBe(
      ROOT_NUMBER,
    );
  });

  it("adds a named account through the guided wizard order without losing the root number", () => {
    const cfg = rootNumberConfig({ accounts: { "Default.": { account: "" } } });
    const authored = structuredClone(cfg);

    // The guided wizard promotes before any Signal hook runs (src/channels/plugins/setup-wizard.ts:63,
    // then validateInput at :167 and applyAccountConfig at :175), so no guard can refuse this add.
    // Before this change the promotion wrote into "Default.", whose own empty account kept the root
    // number from being copied while the root key was still deleted (setup-helpers.ts:313-319), so
    // the number was gone for good. The writer now lands on the canonical key Signal's resolver
    // looks up, through the setup contract the wizard passes (setup-wizard.ts:313), which forwards
    // the adapter's accountEntryLookup declaration.
    const promoted = moveSingleAccountChannelSectionToDefaultAccount({
      cfg,
      channelKey: "signal",
      setupSurface: signalSetupContract as ChannelSetupAdapter,
    });
    expect(
      signalSetupAdapter.validateInput?.({
        cfg: promoted,
        accountId: "work",
        input: externalNativeInput,
      }),
    ).toBeNull();
    const reloaded = reload(
      signalSetupAdapter.applyAccountConfig?.({
        cfg: promoted,
        accountId: "work",
        input: externalNativeInput,
      }),
    );
    const accounts = reloaded.channels?.signal?.accounts;

    expect(Object.keys(accounts ?? {})).toEqual(["Default.", "default", "work"]);
    expect(accounts?.default).toEqual({ account: ROOT_NUMBER });
    expect(accounts?.["Default."]).toEqual(authored.channels?.signal?.accounts?.["Default."]);
    expect(reloaded.channels?.signal?.account).toBeUndefined();
    expect(resolveSignalAccount({ cfg: reloaded, accountId: "default" }).config.account).toBe(
      ROOT_NUMBER,
    );
  });

  it("adds a named account when promotion lands on a padded key the reader case-folds", () => {
    const cfg = rootNumberConfig({
      accounts: { " Default ": { name: "Primary" } },
    });
    const authored = structuredClone(cfg);

    // The lookup Signal declares trims before it lowercases
    // (packages/normalization-core/src/string-coerce.ts:7-17,65-68), so resolveSignalAccount
    // selects " Default " for the id "default" and the promotion has to land there. A writer that
    // only lowercased the key would miss it and seed a canonical twin holding the root number, and
    // that twin would win the reader's exact-key branch and hide the authored name.
    expect(
      signalSetupAdapter.validateInput?.({ cfg, accountId: "work", input: externalNativeInput }),
    ).toBeNull();
    const reloaded = reload(addNamedAccount(cfg, "work"));
    const accounts = reloaded.channels?.signal?.accounts;

    const resolved = resolveSignalAccount({ cfg: reloaded, accountId: "default" });
    expect(resolved.config.name).toBe("Primary");
    expect(resolved.config.account).toBe(ROOT_NUMBER);
    expect(Object.keys(accounts ?? {})).toEqual([" Default ", "work"]);
    expect(accounts?.[" Default "]).toEqual({
      ...authored.channels?.signal?.accounts?.[" Default "],
      account: ROOT_NUMBER,
    });
    expect(reloaded.channels?.signal?.account).toBeUndefined();
  });

  it("sends a named add to doctor when promotion would write the configured default alias", () => {
    const cfg = rootNumberConfig({
      transport: { kind: "container", url: "http://signal-container:8080" },
      defaultAccount: "Work Phone",
      accounts: { "Work Phone": { name: "Work" }, personal: { name: "Personal" } },
    });

    // The promotion writer targets the configured defaultAccount (setup-helpers.ts:370-379), so
    // the oracle has to see the original config to preview this write into "Work Phone".
    expect(
      signalSetupAdapter.validateInput?.({
        cfg,
        accountId: "new-account",
        input: externalNativeInput,
      }),
    ).toBe(
      'Signal account "work-phone" is stored under channels.signal.accounts."Work Phone"; run openclaw doctor --fix to move it to its normalized key, then rerun setup.',
    );
  });

  it("sends a named add to doctor when promotion would write a key Signal lists as default", () => {
    const cfg = rootNumberConfig({
      transport: { kind: "container", url: "http://signal-container:8080" },
      accounts: { "!!!": { name: "Bang" } },
    });

    // Signal lists "!!!" as default, and the declared writer targets the canonical default key.
    // The guard checks that written id against the unrepaired alias and asks for repair before
    // setup can create a second entry. The authored "!!!" key is not the write destination.
    expect(
      signalSetupAdapter.validateInput?.({ cfg, accountId: "work", input: externalNativeInput }),
    ).toBe(
      'Signal account "default" is stored under channels.signal.accounts."!!!"; run openclaw doctor --fix to move it to its normalized key, then rerun setup.',
    );

    const repaired = reload(normalizeCompatibilityConfig({ cfg }).config);
    expect(repaired.channels?.signal?.accounts).toEqual({ default: { name: "Bang" } });
    expect(
      signalSetupAdapter.validateInput?.({
        cfg: repaired,
        accountId: "work",
        input: externalNativeInput,
      }),
    ).toBeNull();
    const reloaded = reload(addNamedAccount(repaired, "work"));

    expect(Object.keys(reloaded.channels?.signal?.accounts ?? {})).toEqual(["default", "work"]);
    expect(reloaded.channels?.signal?.account).toBe(ROOT_NUMBER);
    expect(reloaded.channels?.signal?.accounts?.default).toEqual({ name: "Bang" });
    expect(resolveSignalAccount({ cfg: reloaded, accountId: "default" }).config.account).toBe(
      ROOT_NUMBER,
    );
  });

  it("adds a named account when the configured default resolves to the case-folded winner listed first", () => {
    const cfg = rootNumberConfig({
      transport: { kind: "container", url: "http://signal-container:8080" },
      defaultAccount: "Work Phone",
      accounts: { "Work-Phone": { name: "Winner" }, "Work Phone": { name: "Alias" } },
    });
    const authored = structuredClone(cfg);

    // The configured default names the id "work-phone". The declared writer selects "Work-Phone"
    // for that id, matching the account resolver, and leaves the "Work Phone" alias untouched.
    expect(
      signalSetupAdapter.validateInput?.({
        cfg,
        accountId: "new-account",
        input: externalNativeInput,
      }),
    ).toBeNull();
    const reloaded = reload(addNamedAccount(cfg, "new-account"));
    const accounts = reloaded.channels?.signal?.accounts;

    expect(Object.keys(accounts ?? {})).toEqual(["Work-Phone", "Work Phone", "new-account"]);
    expect(resolveSignalAccount({ cfg: reloaded, accountId: "work-phone" }).config.account).toBe(
      ROOT_NUMBER,
    );
    expect(accounts?.["Work Phone"]).toEqual(authored.channels?.signal?.accounts?.["Work Phone"]);
  });

  it.each([
    {
      order: "DEFAULT before Default",
      accounts: { DEFAULT: { name: "Upper" }, Default: { name: "Title" } },
      untouched: "Default",
    },
    {
      order: "Default before DEFAULT",
      accounts: { Default: { name: "Title" }, DEFAULT: { name: "Upper" } },
      untouched: "DEFAULT",
    },
  ])(
    "adds a named account when promotion lands on the first case-folded key, $order",
    ({ accounts, untouched }) => {
      const cfg = rootNumberConfig({
        transport: { kind: "container", url: "http://signal-container:8080" },
        accounts,
      });
      const authored = structuredClone(cfg);

      // With no exact key the promotion and the account lookup both take the first key in map
      // order (src/channels/plugins/setup-helpers.ts:349-352, src/routing/account-lookup.ts:18-22),
      // so a last-wins lookup would refuse this valid promotion.
      expect(
        signalSetupAdapter.validateInput?.({ cfg, accountId: "work", input: externalNativeInput }),
      ).toBeNull();
      const reloaded = reload(addNamedAccount(cfg, "work"));
      const reloadedAccounts = reloaded.channels?.signal?.accounts;

      expect(Object.keys(reloadedAccounts ?? {})).toEqual([...Object.keys(accounts), "work"]);
      expect(resolveSignalAccount({ cfg: reloaded, accountId: "default" }).config.account).toBe(
        ROOT_NUMBER,
      );
      expect(reloadedAccounts?.[untouched]).toEqual(
        authored.channels?.signal?.accounts?.[untouched],
      );
    },
  );
});
