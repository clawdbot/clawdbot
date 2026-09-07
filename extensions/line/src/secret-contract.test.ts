// Line tests cover secret contract plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createResolverContext } from "openclaw/plugin-sdk/secret-ref-runtime";
import { describe, expect, it } from "vitest";
import { lineChannelPluginCommon } from "./channel-shared.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";

const STORE_TOKEN_REF = { source: "store", provider: "default", id: "LINE_TOKEN" } as const;
const STORE_SECRET_REF = { source: "store", provider: "default", id: "LINE_SECRET" } as const;

function collect(sourceConfig: OpenClawConfig) {
  const context = createResolverContext({ sourceConfig, env: {} });
  collectRuntimeConfigAssignments({
    config: structuredClone(sourceConfig),
    defaults: undefined,
    context,
  });
  return context;
}

describe("LINE secret contract", () => {
  it("publishes both credential targets on the account and channel surfaces", () => {
    expect(secretTargetRegistryEntries.map((entry) => entry.id)).toEqual([
      "channels.line.accounts.*.channelAccessToken",
      "channels.line.accounts.*.channelSecret",
      "channels.line.channelAccessToken",
      "channels.line.channelSecret",
    ]);
  });

  it("publishes the contract on the plugin so the secret target CLI can read it", () => {
    expect(lineChannelPluginCommon.secrets?.secretTargetRegistryEntries).toBe(
      secretTargetRegistryEntries,
    );
    expect(lineChannelPluginCommon.secrets?.collectRuntimeConfigAssignments).toBe(
      collectRuntimeConfigAssignments,
    );
  });

  it("collects channel-level credentials when no accounts map narrows them", () => {
    const context = collect({
      channels: {
        line: {
          enabled: true,
          channelAccessToken: STORE_TOKEN_REF,
          channelSecret: STORE_SECRET_REF,
        },
      },
    });

    expect(context.assignments.map((assignment) => [assignment.path, assignment.ownerId])).toEqual([
      ["channels.line.channelAccessToken", "line:default"],
      ["channels.line.channelSecret", "line:default"],
    ]);
    expect(context.warnings).toStrictEqual([]);
  });

  it("collects channel-level credentials for the default account the accounts map never names", () => {
    const context = collect({
      channels: {
        line: {
          enabled: true,
          channelAccessToken: STORE_TOKEN_REF,
          channelSecret: STORE_SECRET_REF,
          accounts: { work: { channelAccessToken: "work-token", channelSecret: "work-secret" } },
        },
      },
    });

    expect(context.assignments.map((assignment) => [assignment.path, assignment.ownerId])).toEqual([
      ["channels.line.channelAccessToken", "line:default"],
      ["channels.line.channelSecret", "line:default"],
    ]);
    expect(context.warnings).toStrictEqual([]);
  });

  it("leaves a channel-level signing secret unresolved when no default account is admitted", () => {
    const context = collect({
      channels: {
        line: {
          enabled: true,
          channelSecret: STORE_SECRET_REF,
          accounts: { work: { channelAccessToken: "work-token", channelSecret: "work-secret" } },
        },
      },
    });

    expect(context.assignments).toStrictEqual([]);
    expect(context.warnings).toEqual([
      {
        code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
        path: "channels.line.channelSecret",
        message:
          "channels.line.channelSecret: no enabled LINE account inherits this channel-level channelSecret.",
      },
    ]);
  });

  it("leaves a channel-level credential unresolved once accounts.default supplies its own", () => {
    const context = collect({
      channels: {
        line: {
          enabled: true,
          channelAccessToken: STORE_TOKEN_REF,
          accounts: { default: { channelAccessToken: "inline-token" } },
        },
      },
    });

    expect(context.assignments).toStrictEqual([]);
    expect(context.warnings).toEqual([
      {
        code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
        path: "channels.line.channelAccessToken",
        message:
          "channels.line.channelAccessToken: no enabled LINE account inherits this channel-level channelAccessToken.",
      },
    ]);
  });

  it("leaves a channel-level credential unresolved once accounts.default names its own file", () => {
    const context = collect({
      channels: {
        line: {
          enabled: true,
          channelAccessToken: STORE_TOKEN_REF,
          accounts: { default: { tokenFile: "/run/secrets/line-token" } },
        },
      },
    });

    expect(context.assignments).toStrictEqual([]);
    expect(context.warnings).toEqual([
      {
        code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
        path: "channels.line.channelAccessToken",
        message:
          "channels.line.channelAccessToken: no enabled LINE account inherits this channel-level channelAccessToken.",
      },
    ]);
  });

  it("names the disabled channel rather than a missing consumer", () => {
    const context = collect({
      channels: { line: { enabled: false, channelAccessToken: STORE_TOKEN_REF } },
    });

    expect(context.assignments).toStrictEqual([]);
    expect(context.warnings).toEqual([
      {
        code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
        path: "channels.line.channelAccessToken",
        message: "channels.line.channelAccessToken: LINE channel is disabled.",
      },
    ]);
  });

  it("leaves a channel-level signing secret unresolved when no accounts map narrows it either", () => {
    const context = collect({
      channels: { line: { enabled: true, channelSecret: STORE_SECRET_REF } },
    });

    expect(context.assignments).toStrictEqual([]);
    expect(context.warnings).toEqual([
      {
        code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
        path: "channels.line.channelSecret",
        message:
          "channels.line.channelSecret: no enabled LINE account inherits this channel-level channelSecret.",
      },
    ]);
  });

  it("treats an account id the router cannot read as a different account than the default", () => {
    const context = collect({
      channels: {
        line: {
          enabled: true,
          channelAccessToken: STORE_TOKEN_REF,
          accounts: { "!!!": { channelSecret: "named-secret" } },
        },
      },
    });

    expect(context.assignments.map((assignment) => [assignment.path, assignment.ownerId])).toEqual([
      ["channels.line.channelAccessToken", "line:default"],
    ]);
    expect(context.warnings).toStrictEqual([]);
  });

  it("collects an account's own credentials", () => {
    const context = collect({
      channels: {
        line: {
          enabled: true,
          accounts: {
            work: { channelAccessToken: STORE_TOKEN_REF, channelSecret: STORE_SECRET_REF },
          },
        },
      },
    });

    expect(context.assignments.map((assignment) => assignment.path)).toEqual([
      "channels.line.accounts.work.channelAccessToken",
      "channels.line.accounts.work.channelSecret",
    ]);
    expect(context.warnings).toStrictEqual([]);
  });

  it("warns instead of resolving credentials a disabled account owns", () => {
    const context = collect({
      channels: {
        line: {
          enabled: true,
          accounts: { work: { enabled: false, channelAccessToken: STORE_TOKEN_REF } },
        },
      },
    });

    expect(context.assignments).toStrictEqual([]);
    expect(context.warnings).toEqual([
      {
        code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
        path: "channels.line.accounts.work.channelAccessToken",
        message: "channels.line.accounts.work.channelAccessToken: LINE account is disabled.",
      },
    ]);
  });
});
