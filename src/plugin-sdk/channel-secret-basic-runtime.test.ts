import { describe, expect, it } from "vitest";
import {
  collectConditionalChannelFieldAssignments,
  collectSimpleChannelFieldAssignments,
  createChannelSecretTargetRegistryEntries,
  resolveChannelAccountSurface,
  type ResolverContext,
} from "./channel-secret-basic-runtime.js";

function createContext(): ResolverContext {
  return {
    sourceConfig: {},
    env: {},
    cache: {},
    warnings: [],
    warningKeys: new Set(),
    assignments: [],
  };
}

describe("createChannelSecretTargetRegistryEntries", () => {
  it("builds account and channel SecretInput targets with fixed registry metadata", () => {
    expect(
      createChannelSecretTargetRegistryEntries({
        channelKey: "example",
        account: ["token"],
        channel: ["token"],
      }),
    ).toEqual([
      {
        id: "channels.example.accounts.*.token",
        targetType: "channels.example.accounts.*.token",
        configFile: "openclaw.json",
        pathPattern: "channels.example.accounts.*.token",
        secretShape: "secret_input",
        expectedResolvedValue: "string",
        includeInPlan: true,
        includeInConfigure: true,
        includeInAudit: true,
      },
      {
        id: "channels.example.token",
        targetType: "channels.example.token",
        configFile: "openclaw.json",
        pathPattern: "channels.example.token",
        secretShape: "secret_input",
        expectedResolvedValue: "string",
        includeInPlan: true,
        includeInConfigure: true,
        includeInAudit: true,
      },
    ]);
  });

  it("supports sibling refs and CLI target aliases", () => {
    expect(
      createChannelSecretTargetRegistryEntries({
        channelKey: "example",
        account: [
          {
            path: "credentials",
            refPath: "credentialsRef",
            targetType: "channels.example.credentials",
            targetTypeAliases: ["channels.example.accounts.*.credentials"],
            secretShape: "sibling_ref",
            expectedResolvedValue: "string-or-object",
            accountIdPathSegmentIndex: 3,
          },
        ],
      })[0],
    ).toMatchObject({
      id: "channels.example.accounts.*.credentials",
      targetType: "channels.example.credentials",
      targetTypeAliases: ["channels.example.accounts.*.credentials"],
      pathPattern: "channels.example.accounts.*.credentials",
      refPathPattern: "channels.example.accounts.*.credentialsRef",
      secretShape: "sibling_ref",
      expectedResolvedValue: "string-or-object",
      accountIdPathSegmentIndex: 3,
    });
  });

  it("partitions inherited and overridden credentials by channel account", () => {
    const channel = {
      token: { source: "env" as const, provider: "default", id: "FIXTURE_SHARED" },
      accounts: {
        alpha: {},
        beta: {
          token: { source: "env" as const, provider: "default", id: "FIXTURE_BETA" },
        },
        disabled: { enabled: false },
      },
    };
    const context = createContext();

    collectSimpleChannelFieldAssignments({
      channelKey: "example",
      field: "token",
      channel,
      surface: resolveChannelAccountSurface(channel),
      defaults: undefined,
      context,
      topInactiveReason: "inactive",
      accountInactiveReason: "inactive account",
    });

    expect(
      context.assignments.map(({ path, ownerKind, ownerId }) => ({ path, ownerKind, ownerId })),
    ).toEqual([
      {
        path: "channels.example.token",
        ownerKind: "account",
        ownerId: "example:alpha",
      },
      {
        path: "channels.example.accounts.beta.token",
        ownerKind: "account",
        ownerId: "example:beta",
      },
    ]);
  });

  it("keeps inherited webhook credentials owned only by webhook-mode accounts", () => {
    const channel = {
      webhookSecret: { source: "env" as const, provider: "default", id: "FIXTURE_WEBHOOK" },
      accounts: {
        webhook: { mode: "webhook" },
        polling: { mode: "polling" },
        override: {
          mode: "webhook",
          webhookSecret: {
            source: "env" as const,
            provider: "default",
            id: "FIXTURE_OVERRIDE",
          },
        },
      },
    };
    const context = createContext();
    const surface = resolveChannelAccountSurface(channel);

    collectConditionalChannelFieldAssignments({
      channelKey: "example",
      field: "webhookSecret",
      channel,
      surface,
      defaults: undefined,
      context,
      topLevelActiveWithoutAccounts: true,
      topLevelInheritedAccountActive: ({ account, enabled }) =>
        enabled && account.mode === "webhook" && !Object.hasOwn(account, "webhookSecret"),
      accountActive: ({ account, enabled }) => enabled && account.mode === "webhook",
      topInactiveReason: "webhook mode inactive",
      accountInactiveReason: "account webhook mode inactive",
    });

    expect(context.assignments.map(({ path, ownerId }) => ({ path, ownerId }))).toEqual([
      { path: "channels.example.webhookSecret", ownerId: "example:webhook" },
      {
        path: "channels.example.accounts.override.webhookSecret",
        ownerId: "example:override",
      },
    ]);
  });

  it("binds every consumer of one inherited field to the same atomic contract", () => {
    const collect = (betaEndpoint: string, reverseAccounts = false) => {
      const accounts = {
        alpha: { endpoint: "https://alpha.example.invalid" },
        beta: { endpoint: betaEndpoint },
      };
      const channel = {
        token: { source: "env" as const, provider: "default", id: "FIXTURE_SHARED" },
        accounts: reverseAccounts
          ? { beta: accounts.beta, alpha: accounts.alpha }
          : { alpha: accounts.alpha, beta: accounts.beta },
      };
      const context = createContext();
      collectSimpleChannelFieldAssignments({
        channelKey: "example",
        field: "token",
        channel,
        surface: resolveChannelAccountSurface(channel),
        defaults: undefined,
        context,
        topInactiveReason: "inactive",
        accountInactiveReason: "inactive account",
      });
      return context.assignments.map((assignment) => assignment.ownerContractDigest);
    };

    const initial = collect("https://beta.example.invalid");
    const changed = collect("https://changed.example.invalid");
    expect(initial).toHaveLength(2);
    expect(new Set(initial).size).toBe(1);
    expect(new Set(collect("https://beta.example.invalid", true))).toEqual(new Set(initial));
    expect(new Set(changed).size).toBe(1);
    expect(changed[0]).not.toBe(initial[0]);
  });
});
