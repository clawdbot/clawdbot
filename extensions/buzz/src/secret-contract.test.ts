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

  it("collects named-account Buzz SecretRefs", () => {
    const sourceConfig = {
      channels: {
        buzz: {
          accounts: {
            ada: {
              relayUrl: "wss://ada.example.com",
              privateKey: { source: "file", provider: "vault", id: "/buzz/ada-key" },
              authTag: { source: "exec", provider: "vault", id: "buzz-ada-auth-tag" },
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

    expect(context.assignments.map(({ path, ref }) => ({ path, ref }))).toEqual([
      {
        path: "channels.buzz.accounts.ada.privateKey",
        ref: { source: "file", provider: "vault", id: "/buzz/ada-key" },
      },
      {
        path: "channels.buzz.accounts.ada.authTag",
        ref: { source: "exec", provider: "vault", id: "buzz-ada-auth-tag" },
      },
    ]);
  });

  it("does not assign legacy root credentials to named accounts", () => {
    const sourceConfig = {
      channels: {
        buzz: {
          privateKey: { source: "file", provider: "vault", id: "/buzz/default-key" },
          accounts: {
            ada: {
              relayUrl: "wss://ada.example.com",
              privateKey: { source: "file", provider: "vault", id: "/buzz/ada-key" },
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

    expect(context.assignments.map(({ path, ownerId }) => ({ path, ownerId }))).toEqual([
      { path: "channels.buzz.privateKey", ownerId: "buzz:default" },
      { path: "channels.buzz.accounts.ada.privateKey", ownerId: "buzz:ada" },
    ]);
  });
});
