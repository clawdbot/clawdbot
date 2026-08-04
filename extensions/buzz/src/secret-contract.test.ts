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

  it("collects a named account SecretRef", () => {
    const sourceConfig = {
      channels: {
        buzz: {
          accounts: {
            support: {
              relayUrl: "wss://buzz.example.com",
              privateKey: { source: "file", provider: "vault", id: "/buzz/support-key" },
            },
          },
        },
      },
    } as OpenClawConfig;
    const context = createResolverContext({ sourceConfig, env: {} });

    collectRuntimeConfigAssignments({
      config: structuredClone(sourceConfig),
      defaults: undefined,
      context,
    });

    expect(context.assignments).toHaveLength(1);
    expect(context.assignments[0]).toMatchObject({
      path: "channels.buzz.accounts.support.privateKey",
      ref: { source: "file", provider: "vault", id: "/buzz/support-key" },
    });
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
