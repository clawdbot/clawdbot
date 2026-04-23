import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import {
  getDiscordExecApprovalApprovers,
  isDiscordExecApprovalApprover,
  isDiscordExecApprovalClientEnabled,
} from "./exec-approvals.js";

function buildConfig(
  execApprovals?: NonNullable<NonNullable<OpenClawConfig["channels"]>["discord"]>["execApprovals"],
  channelOverrides?: Partial<NonNullable<NonNullable<OpenClawConfig["channels"]>["discord"]>>,
): OpenClawConfig {
  return {
    channels: {
      discord: {
        token: "discord-token",
        ...channelOverrides,
        execApprovals,
      },
    },
  } as OpenClawConfig;
}

describe("discord exec approvals", () => {
  it("requires explicit enablement even when owner approvers resolve", () => {
    expect(isDiscordExecApprovalClientEnabled({ cfg: buildConfig() })).toBe(false);
    expect(
      isDiscordExecApprovalClientEnabled({
        cfg: buildConfig({ enabled: true }),
      }),
    ).toBe(false);
    expect(
      isDiscordExecApprovalClientEnabled({
        cfg: buildConfig({ approvers: ["123"] }),
      }),
    ).toBe(false);
    expect(
      isDiscordExecApprovalClientEnabled({
        cfg: {
          ...buildConfig(),
          commands: { ownerAllowFrom: ["discord:789"] },
        } as OpenClawConfig,
      }),
    ).toBe(false);
    expect(
      isDiscordExecApprovalClientEnabled({
        cfg: buildConfig({ enabled: "auto", approvers: ["123"] }),
      }),
    ).toBe(true);
    expect(
      isDiscordExecApprovalClientEnabled({
        cfg: buildConfig({ enabled: false, approvers: ["123"] }),
      }),
    ).toBe(false);
  });

  it("prefers explicit approvers when configured", () => {
    const cfg = buildConfig({ approvers: ["456"] }, { allowFrom: ["123"], defaultTo: "user:789" });

    expect(getDiscordExecApprovalApprovers({ cfg })).toEqual(["456"]);
    expect(isDiscordExecApprovalApprover({ cfg, senderId: "456" })).toBe(true);
    expect(isDiscordExecApprovalApprover({ cfg, senderId: "123" })).toBe(false);
  });

  it("does not infer approvers from allowFrom or default DM routes", () => {
    const cfg = buildConfig(
      { enabled: true },
      {
        allowFrom: ["123"],
        dm: { allowFrom: ["456"] },
        defaultTo: "user:789",
      },
    );

    expect(getDiscordExecApprovalApprovers({ cfg })).toEqual([]);
    expect(isDiscordExecApprovalApprover({ cfg, senderId: "789" })).toBe(false);
  });

  it("falls back to commands.ownerAllowFrom for exec approvers", () => {
    const cfg = {
      ...buildConfig(),
      commands: { ownerAllowFrom: ["discord:123", "user:456", "789"] },
    } as OpenClawConfig;

    expect(getDiscordExecApprovalApprovers({ cfg })).toEqual(["123", "456", "789"]);
    expect(isDiscordExecApprovalApprover({ cfg, senderId: "456" })).toBe(true);
  });
});
