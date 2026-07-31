// Channel contract suites provide reusable expectations for channel plugin test coverage.
import { expect, it } from "vitest";
import type { ChannelSetupDmPolicy } from "../../channels/plugins/setup-wizard-types.js";
import type {
  ChannelAccountSnapshot,
  ChannelAccountState,
  ChannelSetupInput,
} from "../../channels/plugins/types.core.js";
import type {
  ChannelMessageActionName,
  ChannelMessageCapability,
  ChannelPlugin,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";

function sortStrings(values: readonly string[]) {
  return [...values].toSorted((left, right) => left.localeCompare(right));
}

function resolveContractMessageDiscovery(params: {
  plugin: Pick<ChannelPlugin, "actions">;
  cfg: OpenClawConfig;
}) {
  const actions = params.plugin.actions;
  if (!actions) {
    return {
      actions: [] as ChannelMessageActionName[],
      capabilities: [] as readonly ChannelMessageCapability[],
    };
  }
  const discovery = actions.describeMessageTool({ cfg: params.cfg }) ?? null;
  return {
    actions: Array.isArray(discovery?.actions) ? [...discovery.actions] : [],
    capabilities: Array.isArray(discovery?.capabilities) ? discovery.capabilities : [],
  };
}

export function installChannelPluginContractSuite(params: {
  plugin: Pick<ChannelPlugin, "id" | "meta" | "capabilities" | "config">;
}) {
  it("satisfies the base channel plugin contract", () => {
    expectChannelPluginContract(params.plugin);
  });
}

export function expectChannelPluginContract(
  plugin: Pick<ChannelPlugin, "id" | "meta" | "capabilities" | "config">,
) {
  expect(typeof plugin.id).toBe("string");
  expect(plugin.id.trim()).not.toBe("");

  expect(plugin.meta.id).toBe(plugin.id);
  expect(plugin.meta.label.trim()).not.toBe("");
  expect(plugin.meta.selectionLabel.trim()).not.toBe("");
  expect(plugin.meta.docsPath).toMatch(/^\/channels\//);
  expect(plugin.meta.blurb.trim()).not.toBe("");

  expect(plugin.capabilities.chatTypes.length).toBeGreaterThan(0);

  expect(typeof plugin.config.listAccountIds).toBe("function");
  expect(typeof plugin.config.resolveAccount).toBe("function");
}

type ChannelActionsContractCase = {
  name: string;
  cfg: OpenClawConfig;
  expectedActions: readonly ChannelMessageActionName[];
  expectedCapabilities?: readonly ChannelMessageCapability[];
  beforeTest?: () => void;
};

export function installChannelActionsContractSuite(params: {
  plugin: Pick<ChannelPlugin, "id" | "actions">;
  cases: readonly ChannelActionsContractCase[];
  unsupportedAction?: ChannelMessageActionName;
}) {
  it("exposes the base message actions contract", () => {
    expect(params.plugin.actions).toBeDefined();
    expect(typeof params.plugin.actions?.describeMessageTool).toBe("function");
  });

  for (const testCase of params.cases) {
    it(`actions contract: ${testCase.name}`, () => {
      testCase.beforeTest?.();

      const discovery = resolveContractMessageDiscovery({
        plugin: params.plugin,
        cfg: testCase.cfg,
      });
      const actions = discovery.actions;
      const capabilities = discovery.capabilities;

      expect(actions).toEqual([...new Set(actions)]);
      expect(capabilities).toEqual([...new Set(capabilities)]);
      expect(sortStrings(actions)).toEqual(sortStrings(testCase.expectedActions));
      expect(sortStrings(capabilities)).toEqual(sortStrings(testCase.expectedCapabilities ?? []));

      if (params.plugin.actions?.supportsAction) {
        for (const action of testCase.expectedActions) {
          expect(params.plugin.actions.supportsAction({ action })).toBe(true);
        }
        if (
          params.unsupportedAction &&
          !testCase.expectedActions.includes(params.unsupportedAction)
        ) {
          expect(params.plugin.actions.supportsAction({ action: params.unsupportedAction })).toBe(
            false,
          );
        }
      }
    });
  }
}

type ChannelSetupContractCase<ResolvedAccount, SetupInput extends ChannelSetupInput> = {
  name: string;
  cfg: OpenClawConfig;
  accountId?: string;
  input: SetupInput;
  expectedAccountId?: string;
  expectedValidation?: string | null;
  beforeTest?: () => void;
  assertPatchedConfig?: (cfg: OpenClawConfig) => void;
  assertResolvedAccount?: (account: ResolvedAccount, cfg: OpenClawConfig) => void;
};

export function installChannelSetupContractSuite<
  ResolvedAccount,
  SetupInput extends ChannelSetupInput = ChannelSetupInput,
>(params: {
  plugin: Pick<ChannelPlugin<ResolvedAccount>, "id" | "config" | "setup">;
  cases: readonly ChannelSetupContractCase<ResolvedAccount, SetupInput>[];
}) {
  it("exposes the base setup contract", () => {
    expect(params.plugin.setup).toBeDefined();
    expect(typeof params.plugin.setup?.applyAccountConfig).toBe("function");
  });

  for (const testCase of params.cases) {
    it(`setup contract: ${testCase.name}`, () => {
      testCase.beforeTest?.();

      const resolvedAccountId =
        params.plugin.setup?.resolveAccountId?.({
          cfg: testCase.cfg,
          accountId: testCase.accountId,
          input: testCase.input,
        }) ??
        testCase.accountId ??
        "default";

      expect(resolvedAccountId).toBe(testCase.expectedAccountId ?? resolvedAccountId);

      const validation =
        params.plugin.setup?.validateInput?.({
          cfg: testCase.cfg,
          accountId: resolvedAccountId,
          input: testCase.input,
        }) ?? null;
      expect(validation).toBe(testCase.expectedValidation ?? null);

      const nextCfg = params.plugin.setup?.applyAccountConfig({
        cfg: testCase.cfg,
        accountId: resolvedAccountId,
        input: testCase.input,
      });
      expect(nextCfg).toBeDefined();

      const account = params.plugin.config.resolveAccount(nextCfg!, resolvedAccountId);
      testCase.assertPatchedConfig?.(nextCfg!);
      testCase.assertResolvedAccount?.(account, nextCfg!);
    });
  }
}

type ChannelDmPolicyConfig = {
  dmPolicy?: unknown;
  allowFrom?: unknown;
  accounts?: Record<string, ChannelDmPolicyConfig | undefined>;
};

type ChannelDmPolicyContractCase = {
  name: string;
  channel: string;
  accountId: string;
  accountConfig: Record<string, unknown>;
  inheritedAllowFrom: ReadonlyArray<string | number>;
  defaultAccount?: {
    rootAllowFrom?: ReadonlyArray<string | number>;
    accountAllowFrom?: ReadonlyArray<string | number>;
  };
};

function createDmPolicyContractConfig(params: {
  testCase: ChannelDmPolicyContractCase;
  mode: "read" | "write" | "default";
}): OpenClawConfig {
  const { testCase } = params;
  const defaultAccount = params.mode === "default" ? testCase.defaultAccount : undefined;
  const account = {
    ...testCase.accountConfig,
    ...(params.mode === "write" ? {} : { dmPolicy: "allowlist" }),
    ...(defaultAccount?.accountAllowFrom
      ? { allowFrom: [...defaultAccount.accountAllowFrom] }
      : {}),
  };
  const rootAllowFrom =
    params.mode === "write" ? testCase.inheritedAllowFrom : defaultAccount?.rootAllowFrom;
  return {
    channels: {
      [testCase.channel]: {
        ...(params.mode === "write" ? {} : { dmPolicy: "disabled" }),
        ...(params.mode === "default" ? { defaultAccount: testCase.accountId } : {}),
        ...(rootAllowFrom ? { allowFrom: [...rootAllowFrom] } : {}),
        accounts: { [testCase.accountId]: account },
      },
    },
  } as OpenClawConfig;
}

function addExpectedWildcard(values: ReadonlyArray<string | number> | undefined) {
  return values?.includes("*") ? [...values] : [...(values ?? []), "*"];
}

function resolveDmPolicyConfig(
  cfg: OpenClawConfig,
  channel: string,
  accountId: string,
): { channel: ChannelDmPolicyConfig; account: ChannelDmPolicyConfig } {
  const channels = cfg.channels as Record<string, ChannelDmPolicyConfig | undefined> | undefined;
  const channelConfig = channels?.[channel];
  const accountConfig = channelConfig?.accounts?.[accountId];
  expect(channelConfig).toBeDefined();
  expect(accountConfig).toBeDefined();
  return { channel: channelConfig!, account: accountConfig! };
}

function expectOpenDmPolicyPatch(params: {
  dmPolicy: ChannelSetupDmPolicy;
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
  resolvedAccountId: string;
  expectedAllowFrom: readonly unknown[];
}) {
  const before = resolveDmPolicyConfig(params.cfg, params.channel, params.resolvedAccountId);
  const beforeRootPolicy = before.channel.dmPolicy;
  const beforeRootAllowFrom = Array.isArray(before.channel.allowFrom)
    ? [...before.channel.allowFrom]
    : before.channel.allowFrom;
  const next = params.dmPolicy.setPolicy(params.cfg, "open", params.accountId);
  const after = resolveDmPolicyConfig(next, params.channel, params.resolvedAccountId);

  expect(after.channel.dmPolicy).toBe(beforeRootPolicy);
  expect(after.channel.allowFrom).toEqual(beforeRootAllowFrom);
  expect(after.account.dmPolicy).toBe("open");
  expect(after.account.allowFrom).toEqual(params.expectedAllowFrom);
}

export function installChannelDmPolicyContractSuite(params: {
  dmPolicy: ChannelSetupDmPolicy;
  cases: readonly ChannelDmPolicyContractCase[];
}) {
  for (const testCase of params.cases) {
    it(`dm policy contract: ${testCase.name} reads the named-account policy`, () => {
      expect(params.dmPolicy.channel).toBe(testCase.channel);
      const cfg = createDmPolicyContractConfig({ testCase, mode: "read" });
      expect(params.dmPolicy.getCurrent(cfg, testCase.accountId)).toBe("allowlist");
    });

    it(`dm policy contract: ${testCase.name} reports account-scoped config keys`, () => {
      expect(params.dmPolicy.resolveConfigKeys?.({}, testCase.accountId)).toEqual({
        policyKey: `channels.${testCase.channel}.accounts.${testCase.accountId}.dmPolicy`,
        allowFromKey: `channels.${testCase.channel}.accounts.${testCase.accountId}.allowFrom`,
      });
    });

    it(`dm policy contract: ${testCase.name} writes open policy with inherited allowFrom`, () => {
      expectOpenDmPolicyPatch({
        dmPolicy: params.dmPolicy,
        cfg: createDmPolicyContractConfig({ testCase, mode: "write" }),
        channel: testCase.channel,
        accountId: testCase.accountId,
        resolvedAccountId: testCase.accountId,
        expectedAllowFrom: addExpectedWildcard(testCase.inheritedAllowFrom),
      });
    });

    const defaultAccount = testCase.defaultAccount;
    if (defaultAccount) {
      it(`dm policy contract: ${testCase.name} uses defaultAccount when accountId is omitted`, () => {
        const cfg = createDmPolicyContractConfig({ testCase, mode: "default" });
        expect(params.dmPolicy.getCurrent(cfg)).toBe("allowlist");
        expect(params.dmPolicy.resolveConfigKeys?.(cfg)).toEqual({
          policyKey: `channels.${testCase.channel}.accounts.${testCase.accountId}.dmPolicy`,
          allowFromKey: `channels.${testCase.channel}.accounts.${testCase.accountId}.allowFrom`,
        });
        expectOpenDmPolicyPatch({
          dmPolicy: params.dmPolicy,
          cfg,
          channel: testCase.channel,
          resolvedAccountId: testCase.accountId,
          expectedAllowFrom: addExpectedWildcard(
            defaultAccount.accountAllowFrom ?? defaultAccount.rootAllowFrom,
          ),
        });
      });
    }
  }
}

type ChannelStatusContractCase<Probe> = {
  name: string;
  cfg: OpenClawConfig;
  accountId?: string;
  runtime?: ChannelAccountSnapshot;
  probe?: Probe;
  beforeTest?: () => void;
  expectedState?: ChannelAccountState;
  resolveStateInput?: {
    configured: boolean;
    enabled: boolean;
  };
  assertSnapshot?: (snapshot: ChannelAccountSnapshot) => void;
  assertSummary?: (summary: Record<string, unknown>) => void;
};

export function installChannelStatusContractSuite<ResolvedAccount, Probe = unknown>(params: {
  plugin: Pick<ChannelPlugin<ResolvedAccount, Probe>, "id" | "config" | "status">;
  cases: readonly ChannelStatusContractCase<Probe>[];
}) {
  it("exposes the base status contract", () => {
    expect(params.plugin.status).toBeDefined();
    expect(typeof params.plugin.status?.buildAccountSnapshot).toBe("function");
  });

  if (params.plugin.status?.defaultRuntime) {
    it("status contract: default runtime is shaped like an account snapshot", () => {
      expect(typeof params.plugin.status?.defaultRuntime?.accountId).toBe("string");
    });
  }

  for (const testCase of params.cases) {
    it(`status contract: ${testCase.name}`, async () => {
      testCase.beforeTest?.();

      const account = params.plugin.config.resolveAccount(testCase.cfg, testCase.accountId);
      const snapshot = await params.plugin.status!.buildAccountSnapshot!({
        account,
        cfg: testCase.cfg,
        runtime: testCase.runtime,
        probe: testCase.probe,
      });

      expect(typeof snapshot.accountId).toBe("string");
      expect(snapshot.accountId.trim()).not.toBe("");
      testCase.assertSnapshot?.(snapshot);

      if (params.plugin.status?.buildChannelSummary) {
        const defaultAccountId =
          params.plugin.config.defaultAccountId?.(testCase.cfg) ?? testCase.accountId ?? "default";
        const summary = await params.plugin.status.buildChannelSummary({
          account,
          cfg: testCase.cfg,
          defaultAccountId,
          snapshot,
        });
        expect(summary).toEqual(expect.any(Object));
        testCase.assertSummary?.(summary);
      }

      if (testCase.expectedState && params.plugin.status?.resolveAccountState) {
        const state = params.plugin.status.resolveAccountState({
          account,
          cfg: testCase.cfg,
          configured: testCase.resolveStateInput?.configured ?? true,
          enabled: testCase.resolveStateInput?.enabled ?? true,
        });
        expect(state).toBe(testCase.expectedState);
      }
    });
  }
}
