// Unit tests for createSlackSetupWizardProxy. The Slack channel plugin
// installs this proxy as setupWizard so the heavy ./setup-surface module is
// only imported when wizard methods that actually need it are invoked.
//
// These tests use a fake loader so the proxy can be tested type-safely
// against the wider ChannelSetupWizard contract, without going through the
// (narrower) ChannelPluginSetupWizard surface exposed on slackPlugin.

import type { ChannelSetupWizard } from "openclaw/plugin-sdk/setup-runtime";
import { describe, expect, it, vi } from "vitest";
import { createSlackSetupWizardProxy } from "./setup-core.js";

function makeFakeWizard(overrides: Partial<ChannelSetupWizard> = {}): ChannelSetupWizard {
  return {
    channel: "slack",
    status: {
      resolveConfigured: vi.fn(async () => ({ configured: false })),
    },
    credentials: [],
    ...overrides,
  } as ChannelSetupWizard;
}

describe("createSlackSetupWizardProxy", () => {
  it("does not load the wizard module just by constructing the proxy", () => {
    const loader = vi.fn(async () => ({ slackSetupWizard: makeFakeWizard() }));
    const proxy = createSlackSetupWizardProxy(loader);
    expect(proxy).toBeDefined();
    expect(loader).not.toHaveBeenCalled();
  });

  it("forwards allowFrom.resolveEntries to the lazily loaded wizard and propagates its result", async () => {
    const sentinel = [{ input: "U123", resolved: true, id: "U123" }];
    const resolveEntries = vi.fn(async () => sentinel);
    // The full ChannelSetupWizardAllowFrom type carries many UI-only fields
    // (placeholder, parseId, etc.) that are irrelevant to the proxy's
    // delegation contract. Build a minimal stub and cast through unknown so
    // the assertion stays focused on resolveEntries forwarding.
    const fakeWizard = makeFakeWizard({
      allowFrom: {
        resolveEntries,
      } as unknown as ChannelSetupWizard["allowFrom"],
    });
    const loader = vi.fn(async () => ({ slackSetupWizard: fakeWizard }));
    const proxy = createSlackSetupWizardProxy(loader);

    const cfg = { channels: { slack: {} } } as never;
    const result = await proxy.allowFrom!.resolveEntries({
      cfg,
      accountId: "default",
      credentialValues: { botToken: "xoxb-bot" },
      entries: ["U123"],
    });

    expect(loader).toHaveBeenCalledTimes(1);
    expect(resolveEntries).toHaveBeenCalledTimes(1);
    expect(resolveEntries).toHaveBeenCalledWith({
      cfg,
      accountId: "default",
      credentialValues: { botToken: "xoxb-bot" },
      entries: ["U123"],
    });
    expect(result).toBe(sentinel);
  });

  it("returns unresolved entries without invoking the lazy wizard when allowFrom is absent on the loaded wizard", async () => {
    const fakeWizard = makeFakeWizard();
    const loader = vi.fn(async () => ({ slackSetupWizard: fakeWizard }));
    const proxy = createSlackSetupWizardProxy(loader);

    const result = await proxy.allowFrom!.resolveEntries({
      cfg: { channels: { slack: {} } } as never,
      accountId: "default",
      credentialValues: {},
      entries: ["U1", "U2"],
    });

    // The proxy still loads the wizard once to inspect its allowFrom shape,
    // then falls back to a "resolved: false" projection of the inputs.
    expect(loader).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      { input: "U1", resolved: false, id: null },
      { input: "U2", resolved: false, id: null },
    ]);
  });

  it("forwards groupAccess.resolveAllowlist when present and uses the configured fallback otherwise", async () => {
    // First: with groupAccess present, the lazy wizard handles resolution.
    const groupResolved = ["G1-resolved"];
    const resolveAllowlist = vi.fn(async () => groupResolved);
    const fakeWithGroupAccess = makeFakeWizard({
      groupAccess: {
        resolveAllowlist,
      } as unknown as ChannelSetupWizard["groupAccess"],
    });
    const loaderA = vi.fn(async () => ({ slackSetupWizard: fakeWithGroupAccess }));
    const proxyA = createSlackSetupWizardProxy(loaderA);

    const cfg = { channels: { slack: {} } } as never;
    const a = await proxyA.groupAccess!.resolveAllowlist!({
      cfg,
      accountId: "default",
      credentialValues: {},
      entries: ["G1"],
      prompter: undefined as never,
    });
    expect(resolveAllowlist).toHaveBeenCalledTimes(1);
    expect(a).toBe(groupResolved);

    // Second: without groupAccess, the fallback (entries -> entries) is used.
    const fakeNoGroupAccess = makeFakeWizard();
    const loaderB = vi.fn(async () => ({ slackSetupWizard: fakeNoGroupAccess }));
    const proxyB = createSlackSetupWizardProxy(loaderB);

    const b = await proxyB.groupAccess!.resolveAllowlist!({
      cfg,
      accountId: "default",
      credentialValues: {},
      entries: ["G1", "G2"],
      prompter: undefined as never,
    });
    // createSlackSetupWizardProxy passes (entries) => entries as the fallback.
    expect(b).toEqual(["G1", "G2"]);
  });
});
