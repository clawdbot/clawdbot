import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createResolverContext } from "openclaw/plugin-sdk/secret-ref-runtime";
import { describe, expect, it } from "vitest";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";

describe("Buzz secret contract", () => {
  it("publishes Buzz credential targets", () => {
    expect(secretTargetRegistryEntries.map((entry) => entry.id)).toEqual([
      "channels.buzz.accounts.*.privateKey",
      "channels.buzz.accounts.*.authTag",
      "channels.buzz.privateKey",
      "channels.buzz.authTag",
    ]);
  });

  it.each([
    { explicitDefault: false, enabled: true, owners: ["buzz:default", "buzz:ada"] },
    { explicitDefault: true, enabled: true, owners: ["buzz:ada"] },
    { explicitDefault: false, enabled: false, owners: [] },
  ])("isolates active credential owners: %j", ({ explicitDefault, enabled, owners }) => {
    const ref = (id: string) => ({ source: "env", provider: "default", id });
    const sourceConfig = {
      channels: {
        buzz: {
          enabled,
          privateKey: ref("ROOT_KEY"),
          accounts: {
            ...(explicitDefault ? { default: {} } : {}),
            ada: { privateKey: ref("ADA_KEY") },
            paused: { enabled: false, privateKey: ref("PAUSED_KEY") },
          },
        },
      },
    } as OpenClawConfig;
    const config = structuredClone(sourceConfig);
    const context = createResolverContext({ sourceConfig, env: {} });
    collectRuntimeConfigAssignments({ config, defaults: undefined, context });
    expect(context.assignments.map((assignment) => assignment.ownerId)).toEqual(owners);
    for (const assignment of context.assignments) {
      expect(assignment).toMatchObject({ requiredForGateway: false, disposition: "isolate" });
      assignment.apply(`resolved-${assignment.ownerId}`);
    }
    expect(config.channels?.buzz?.accounts?.ada?.privateKey).toEqual(
      enabled ? "resolved-buzz:ada" : ref("ADA_KEY"),
    );
    expect(config.channels?.buzz?.privateKey).toEqual(
      enabled && !explicitDefault ? "resolved-buzz:default" : ref("ROOT_KEY"),
    );
  });

  it("binds recovery to only the selected identity and its effective policy", () => {
    const sourceConfig = {
      channels: {
        buzz: {
          privateKey: "root-key",
          groupPolicy: "open",
          accounts: {
            ada: {
              relayUrl: "wss://ada.example.com",
              privateKey: { source: "env", provider: "default", id: "ADA_KEY" },
            },
            grace: { privateKey: "grace-key" },
          },
        },
      },
    } as OpenClawConfig;
    const digest = (config: OpenClawConfig) => {
      const context = createResolverContext({ sourceConfig: config, env: {} });
      collectRuntimeConfigAssignments({ config, defaults: undefined, context });
      return context.assignments.find((entry) => entry.ownerId === "buzz:ada")?.ownerContractDigest;
    };
    const baseline = digest(sourceConfig);
    expect(baseline).toBeTypeOf("string");
    const otherIdentity = structuredClone(sourceConfig);
    otherIdentity.channels!.buzz!.privateKey = "rotated-root";
    otherIdentity.channels!.buzz!.accounts!.grace!.privateKey = "rotated-grace";
    otherIdentity.channels!.buzz!.defaultAccount = "grace";
    expect(digest(otherIdentity)).toBe(baseline);
    const ownIdentity = structuredClone(sourceConfig);
    ownIdentity.channels!.buzz!.accounts!.ada!.relayUrl = "wss://changed.example.com";
    expect(digest(ownIdentity)).not.toBe(baseline);
    const policy = structuredClone(sourceConfig);
    policy.channels!.buzz!.groupPolicy = "allowlist";
    expect(digest(policy)).not.toBe(baseline);
  });

  it("collects configured Buzz SecretRefs", () => {
    const sourceConfig = {
      channels: {
        buzz: {
          enabled: true,
          relayUrl: "wss://buzz.example.com",
          privateKey: { source: "file", provider: "vault", id: "/buzz/private-key" },
          authTag: { source: "exec", provider: "vault", id: "buzz-auth-tag" },
        },
      },
    } as OpenClawConfig;
    const context = createResolverContext({ sourceConfig, env: {} });

    collectRuntimeConfigAssignments({
      config: structuredClone(sourceConfig),
      defaults: undefined,
      context,
    });

    expect(context.assignments.map(({ path, ref }) => ({ path, ref }))).toEqual([
      {
        path: "channels.buzz.privateKey",
        ref: { source: "file", provider: "vault", id: "/buzz/private-key" },
      },
      {
        path: "channels.buzz.authTag",
        ref: { source: "exec", provider: "vault", id: "buzz-auth-tag" },
      },
    ]);
    expect(context.warnings).toStrictEqual([]);
  });
});
