// Open policy allow-from tests cover doctor handling of open allowlist policy.
import { describe, expect, it } from "vitest";
import type { GoogleChatConfig } from "../../../config/types.googlechat.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { GoogleChatConfigSchema } from "../../../config/zod-schema.providers-googlechat.js";
import {
  collectOpenPolicyAllowFromWarnings,
  maybeRepairOpenPolicyAllowFrom,
} from "./open-policy-allowfrom.js";

describe("doctor open-policy allowFrom repair", () => {
  it('adds top-level wildcard when dmPolicy="open" has no allowFrom', () => {
    const result = maybeRepairOpenPolicyAllowFrom({
      channels: {
        signal: {
          dmPolicy: "open",
        },
      },
    });

    expect(result.changes).toEqual([
      '- channels.signal.allowFrom: set to ["*"] (required by dmPolicy="open")',
    ]);
    expect(result.config.channels?.signal?.allowFrom).toEqual(["*"]);
  });

  it("repairs top-level googlechat allowFrom", () => {
    const result = maybeRepairOpenPolicyAllowFrom({
      channels: {
        googlechat: {
          dmPolicy: "open",
        },
      },
    });

    expect(result.changes).toEqual([
      '- channels.googlechat.allowFrom: set to ["*"] (required by dmPolicy="open")',
    ]);
    expect(result.config.channels?.googlechat?.allowFrom).toEqual(["*"]);
    expect(GoogleChatConfigSchema.safeParse(result.config.channels?.googlechat).success).toBe(true);
  });

  it("repairs a named googlechat account with canonical top-level allowFrom", () => {
    const result = maybeRepairOpenPolicyAllowFrom({
      channels: {
        googlechat: {
          accounts: {
            work: { dmPolicy: "open" },
          },
        },
      },
    });

    expect(result.config.channels?.googlechat?.accounts?.work).toEqual({
      dmPolicy: "open",
      allowFrom: ["*"],
    });
    expect(GoogleChatConfigSchema.safeParse(result.config.channels?.googlechat).success).toBe(true);
  });

  it.each<{ label: string; config: GoogleChatConfig }>([
    {
      label: "root",
      config: { dmPolicy: "open", allowFrom: ["*"] },
    },
    {
      label: "root inherited by a named account",
      config: { dmPolicy: "open", allowFrom: ["*"], accounts: { work: {} } },
    },
    {
      label: "named account",
      config: { accounts: { work: { dmPolicy: "open", allowFrom: ["*"] } } },
    },
    {
      label: "default account",
      config: { accounts: { default: { dmPolicy: "open", allowFrom: ["*"] } } },
    },
    {
      label: "root and named override",
      config: {
        dmPolicy: "open",
        allowFrom: ["*"],
        accounts: { work: { dmPolicy: "open", allowFrom: ["*"] } },
      },
    },
  ])("preserves schema-valid googlechat $label DM access", ({ config }) => {
    expect(GoogleChatConfigSchema.safeParse(config).success).toBe(true);

    const result = maybeRepairOpenPolicyAllowFrom({ channels: { googlechat: config } });

    expect(result.changes).toEqual([]);
    expect(result.config.channels?.googlechat).toEqual(config);
    expect(GoogleChatConfigSchema.safeParse(result.config.channels?.googlechat).success).toBe(true);
  });

  it("repairs nested-only matrix dm allowFrom", () => {
    const result = maybeRepairOpenPolicyAllowFrom({
      channels: {
        matrix: {
          dm: {
            policy: "open",
          },
        },
      },
    });

    expect(result.changes).toEqual([
      '- channels.matrix.dm.allowFrom: set to ["*"] (required by dmPolicy="open")',
    ]);
    expect(result.config.channels?.matrix?.allowFrom).toBeUndefined();
    expect(result.config.channels?.matrix?.dm?.allowFrom).toEqual(["*"]);
  });

  it("appends wildcard to discord nested dm allowFrom when top-level is absent", () => {
    const result = maybeRepairOpenPolicyAllowFrom({
      channels: {
        discord: {
          dm: {
            policy: "open",
            allowFrom: ["123"],
          },
        },
      },
    } as unknown as OpenClawConfig);

    expect(result.changes).toEqual([
      '- channels.discord.dmPolicy: set to "open" (migrated from channels.discord.dm.policy)',
      "- channels.discord.dm.allowFrom: removed after moving allowlist to channels.discord.allowFrom",
      '- channels.discord.allowFrom: added "*" (required by dmPolicy="open")',
    ]);
    expect(result.config.channels?.discord?.allowFrom).toEqual(["123", "*"]);
    expect(result.config.channels?.discord?.dm).toBeUndefined();
  });

  it("appends wildcard to existing top-level allowFrom", () => {
    const result = maybeRepairOpenPolicyAllowFrom({
      channels: {
        slack: {
          dmPolicy: "open",
          allowFrom: ["U123"],
        },
      },
    });

    expect(result.config.channels?.slack?.allowFrom).toEqual(["U123", "*"]);
  });

  it("skips top-level allowFrom that already includes a wildcard", () => {
    const result = maybeRepairOpenPolicyAllowFrom({
      channels: {
        discord: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    });

    expect(result.changes).toStrictEqual([]);
    expect(result.config.channels?.discord?.allowFrom).toEqual(["*"]);
  });

  it("repairs per-account open dmPolicy without allowFrom", () => {
    const result = maybeRepairOpenPolicyAllowFrom({
      channels: {
        discord: {
          accounts: {
            work: {
              dmPolicy: "open",
            },
          },
        },
      },
    });

    expect(result.config.channels?.discord?.accounts?.work?.allowFrom).toEqual(["*"]);
  });

  it("formats open-policy wildcard warnings", () => {
    const warnings = collectOpenPolicyAllowFromWarnings({
      changes: ['- channels.signal.allowFrom: set to ["*"] (required by dmPolicy="open")'],
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings).toEqual([
      '- channels.signal.allowFrom: set to ["*"] (required by dmPolicy="open")',
      '- Run "openclaw doctor --fix" to add missing allowFrom wildcards.',
    ]);
  });
});
