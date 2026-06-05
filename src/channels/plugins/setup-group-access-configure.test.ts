// Setup group access configure tests cover channel setup writes for group access config.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { configureChannelAccessWithAllowlist } from "./setup-group-access-configure.js";
import type { ChannelAccessPolicy } from "./setup-group-access.js";

function createPrompter(params: { confirm: boolean; policy?: ChannelAccessPolicy; text?: string }) {
  return {
    confirm: vi.fn(async () => params.confirm),
    select: vi.fn(async () => params.policy ?? "allowlist"),
    text: vi.fn(async () => params.text ?? ""),
    note: vi.fn(),
  };
}

async function runConfigureChannelAccess<TResolved>(params: {
  cfg: OpenClawConfig;
  prompter: ReturnType<typeof createPrompter>;
  label?: string;
  placeholder?: string;
  setPolicy: (cfg: OpenClawConfig, policy: ChannelAccessPolicy) => OpenClawConfig;
  resolveAllowlist: (params: { cfg: OpenClawConfig; entries: string[] }) => Promise<TResolved>;
  applyAllowlist: (params: { cfg: OpenClawConfig; resolved: TResolved }) => OpenClawConfig;
}) {
  return await configureChannelAccessWithAllowlist({
    cfg: params.cfg,
    prompter: params.prompter as any,
    label: params.label ?? "Slack channels",
    currentPolicy: "allowlist",
    currentEntries: [],
    placeholder: params.placeholder ?? "#general",
    updatePrompt: true,
    setPolicy: params.setPolicy,
    resolveAllowlist: params.resolveAllowlist,
    applyAllowlist: params.applyAllowlist,
  });
}

describe("configureChannelAccessWithAllowlist", () => {
  it("returns input config when user skips access configuration", async () => {
    const cfg: OpenClawConfig = {};
    const prompter = createPrompter({ confirm: false });
    const setPolicy = vi.fn((next: OpenClawConfig) => next);
    const resolveAllowlist = vi.fn(async () => [] as string[]);
    const applyAllowlist = vi.fn((params: { cfg: OpenClawConfig }) => params.cfg);

    const next = await runConfigureChannelAccess({
      cfg,
      prompter,
      setPolicy,
      resolveAllowlist,
      applyAllowlist,
    });

    expect(next).toBe(cfg);
    expect(setPolicy).not.toHaveBeenCalled();
    expect(resolveAllowlist).not.toHaveBeenCalled();
    expect(applyAllowlist).not.toHaveBeenCalled();
  });

  it("applies non-allowlist policy directly", async () => {
    const cfg: OpenClawConfig = {};
    const prompter = createPrompter({
      confirm: true,
      policy: "open",
    });
    const setPolicy = vi.fn(
      (next: OpenClawConfig, policy: ChannelAccessPolicy): OpenClawConfig => ({
        ...next,
        channels: { discord: { groupPolicy: policy } },
      }),
    );
    const resolveAllowlist = vi.fn(async () => ["ignored"]);
    const applyAllowlist = vi.fn((params: { cfg: OpenClawConfig }) => params.cfg);

    const next = await runConfigureChannelAccess({
      cfg,
      prompter,
      label: "Discord channels",
      placeholder: "guild/channel",
      setPolicy,
      resolveAllowlist,
      applyAllowlist,
    });

    expect(next.channels?.discord?.groupPolicy).toBe("open");
    expect(setPolicy).toHaveBeenCalledWith(cfg, "open");
    expect(resolveAllowlist).not.toHaveBeenCalled();
    expect(applyAllowlist).not.toHaveBeenCalled();
  });

  it("supports allowlist policies without prompting for entries", async () => {
    const cfg: OpenClawConfig = {};
    const prompter = createPrompter({
      confirm: true,
      policy: "allowlist",
    });
    const setPolicy = vi.fn(
      (next: OpenClawConfig, policy: ChannelAccessPolicy): OpenClawConfig => ({
        ...next,
        channels: { twitch: { groupPolicy: policy } },
      }),
    );
    const resolveAllowlist = vi.fn(async () => ["ignored"]);
    const applyAllowlist = vi.fn((params: { cfg: OpenClawConfig }) => params.cfg);

    const next = await configureChannelAccessWithAllowlist({
      cfg,
      prompter: prompter as any,
      label: "Twitch chat",
      currentPolicy: "disabled",
      currentEntries: [],
      placeholder: "",
      updatePrompt: false,
      skipAllowlistEntries: true,
      setPolicy,
      resolveAllowlist,
      applyAllowlist,
    });

    expect(next.channels).toEqual({ twitch: { groupPolicy: "allowlist" } });
    expect(resolveAllowlist).not.toHaveBeenCalled();
    expect(applyAllowlist).not.toHaveBeenCalled();
  });

  it("resolves allowlist entries and applies them after forcing allowlist policy", async () => {
    const cfg: OpenClawConfig = {};
    const prompter = createPrompter({
      confirm: true,
      policy: "allowlist",
      text: "#general, #support",
    });
    const calls: string[] = [];
    const setPolicy = vi.fn((next: OpenClawConfig, policy: ChannelAccessPolicy): OpenClawConfig => {
      calls.push("setPolicy");
      return {
        ...next,
        channels: { slack: { groupPolicy: policy } },
      };
    });
    const resolveAllowlist = vi.fn(async (params: { cfg: OpenClawConfig; entries: string[] }) => {
      calls.push("resolve");
      expect(params.cfg).toBe(cfg);
      expect(params.entries).toEqual(["#general", "#support"]);
      return ["C1", "C2"];
    });
    const applyAllowlist = vi.fn((params: { cfg: OpenClawConfig; resolved: string[] }) => {
      calls.push("apply");
      expect(params.cfg.channels?.slack?.groupPolicy).toBe("allowlist");
      return {
        ...params.cfg,
        channels: {
          ...params.cfg.channels,
          slack: {
            ...params.cfg.channels?.slack,
            channels: Object.fromEntries(params.resolved.map((id) => [id, { enabled: true }])),
          },
        },
      };
    });

    const next = await runConfigureChannelAccess({
      cfg,
      prompter,
      setPolicy,
      resolveAllowlist,
      applyAllowlist,
    });

    expect(calls).toEqual(["resolve", "setPolicy", "apply"]);
    expect(next.channels?.slack?.channels).toEqual({
      C1: { enabled: true },
      C2: { enabled: true },
    });
  });
});
