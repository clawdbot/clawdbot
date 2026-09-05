// Signal tests cover the setup guard comparing a promotion's target with the reader-selected key.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { moveSingleAccountChannelSectionToDefaultAccount } from "openclaw/plugin-sdk/setup";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSignalAccount } from "./accounts.js";
import { signalSetupAdapter } from "./setup-core.js";

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
 */
function addNamedAccount(cfg: OpenClawConfig, accountId: string) {
  const promoted = moveSingleAccountChannelSectionToDefaultAccount({
    cfg,
    channelKey: "signal",
    setupSurface: signalSetupAdapter,
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

  it("sends a named add to a rename when promotion would write a case variant shadowed by the exact key", async () => {
    const cfg = rootNumberConfig({
      accounts: { Default: { name: "Alias" }, default: { name: "Canon" } },
    });
    const renamePointer =
      'Signal account "default" is stored under channels.signal.accounts "default", "Default", and setup would write "Default", which the account lookup does not select. Rename them so one key is "default", then rerun setup.';

    // The promotion targets the first key normalizing to "default"
    // (src/channels/plugins/setup-helpers.ts:325-333), here the case variant listed first, while
    // every reader takes the exact key (src/routing/account-lookup.ts:15-17). Both keys case-fold
    // to the id, so the key assessment gives it no state. Only comparing the written key with the
    // reader-selected key refuses the write.
    expect(
      signalSetupAdapter.validateInput?.({ cfg, accountId: "work", input: externalNativeInput }),
    ).toBe(renamePointer);

    detectSignalTransportMock.mockRejectedValue(new Error("unreachable"));
    const bareInput = { httpUrl: "http://127.0.0.1:9299" };
    const prepared = await signalSetupAdapter.prepareAccountConfigInput?.({
      cfg,
      accountId: "work",
      input: bareInput,
      runtime: {} as never,
    });

    expect(detectSignalTransportMock).not.toHaveBeenCalled();
    expect(prepared).toBe(bareInput);
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

  it("sends a named add to a rename when promotion would write the alias listed before its case-folded winner", () => {
    const cfg = rootNumberConfig({
      accounts: { "Default.": { name: "Alias" }, Default: { name: "Canon" } },
    });

    // The promotion takes the first key normalizing to "default", here the alias listed first
    // (src/channels/plugins/setup-helpers.ts:325-333). The account lookup takes the first key whose
    // lowercase is the id (src/routing/account-lookup.ts:18-22), the case variant. A selected-key
    // search by normalized id would pick the alias and let the root number move where the account
    // lookup never looks.
    expect(
      signalSetupAdapter.validateInput?.({ cfg, accountId: "work", input: externalNativeInput }),
    ).toBe(
      'Signal account "default" is stored under channels.signal.accounts "Default", "Default.", and setup would write "Default.", which the account lookup does not select. Rename them so one key is "default", then rerun setup.',
    );
  });

  it("sends a named add to doctor when promotion would write the configured default alias", () => {
    const cfg = rootNumberConfig({
      transport: { kind: "container", url: "http://signal-container:8080" },
      defaultAccount: "Work Phone",
      accounts: { "Work Phone": { name: "Work" }, personal: { name: "Personal" } },
    });

    // The promotion writer targets the configured defaultAccount (setup-helpers.ts:346-358), so
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

  it("adds a named account when the configured default resolves to the case-folded winner listed first", () => {
    const cfg = rootNumberConfig({
      transport: { kind: "container", url: "http://signal-container:8080" },
      defaultAccount: "Work Phone",
      accounts: { "Work-Phone": { name: "Winner" }, "Work Phone": { name: "Alias" } },
    });
    const authored = structuredClone(cfg);

    // The configured defaultAccount resolves to the first key normalizing to "work-phone"
    // (src/channels/plugins/setup-helpers.ts:346-358), the case variant the account lookup also
    // selects, so the promotion lands where the account resolver looks.
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
      // order (src/channels/plugins/setup-helpers.ts:325-333, src/routing/account-lookup.ts:18-22),
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
