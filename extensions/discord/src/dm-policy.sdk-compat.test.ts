import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiscordConfigSchema } from "./config-schema.js";

const sdk = vi.hoisted((): { available: boolean; calls: number; failure?: Error } => ({
  available: true,
  calls: 0,
}));

vi.mock("openclaw/plugin-sdk/channel-config-schema", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-config-schema")>();
  return {
    ...actual,
    get refineChannelDmPolicy() {
      return sdk.available
        ? (params: Parameters<typeof actual.refineChannelDmPolicy>[0]) => {
            sdk.calls += 1;
            if (sdk.failure) {
              throw sdk.failure;
            }
            return actual.refineChannelDmPolicy(params);
          }
        : undefined;
    },
  };
});

const cases = [
  { name: "root wildcard", config: { dmPolicy: "open", allowFrom: ["*"] }, issues: [] },
  {
    name: "root open without wildcard",
    config: { dmPolicy: "open", allowFrom: ["123"] },
    issues: [
      {
        path: ["allowFrom"],
        message:
          'channels.discord.dmPolicy="open" requires channels.discord.allowFrom to include "*"',
      },
    ],
  },
  {
    name: "root empty allowlist",
    config: { dmPolicy: "allowlist", allowFrom: [" "] },
    issues: [
      {
        path: ["allowFrom"],
        message:
          'channels.discord.dmPolicy="allowlist" requires channels.discord.allowFrom to contain at least one sender ID',
      },
    ],
  },
  {
    name: "inherited account allowance",
    config: { allowFrom: ["123"], accounts: { work: { dmPolicy: "allowlist" } } },
    issues: [],
  },
  {
    name: "explicit empty account override",
    config: { allowFrom: ["123"], accounts: { work: { dmPolicy: "allowlist", allowFrom: [] } } },
    issues: [
      {
        path: ["accounts", "work", "allowFrom"],
        message:
          'channels.discord.accounts.*.dmPolicy="allowlist" requires channels.discord.accounts.*.allowFrom (or channels.discord.allowFrom) to contain at least one sender ID',
      },
    ],
  },
  {
    name: "inherited account open policy",
    config: { dmPolicy: "open", allowFrom: ["*"], accounts: { work: { allowFrom: ["123"] } } },
    issues: [
      {
        path: ["accounts", "work", "allowFrom"],
        message:
          'channels.discord.accounts.*.dmPolicy="open" requires channels.discord.accounts.*.allowFrom (or channels.discord.allowFrom) to include "*"',
      },
    ],
  },
  {
    name: "omitted account",
    config: { dmPolicy: "pairing", accounts: { work: undefined } },
    issues: [],
  },
];

describe.each([true, false])("Discord DM policy (SDK helper available=%s)", (available) => {
  beforeEach(() => {
    sdk.available = available;
    sdk.calls = 0;
    sdk.failure = undefined;
  });

  it.each(cases)("preserves $name validation", ({ config, issues }) => {
    const parsed = DiscordConfigSchema.safeParse(config);
    expect(
      parsed.success ? [] : parsed.error.issues.map(({ path, message }) => ({ path, message })),
    ).toEqual(issues);
    expect(sdk.calls > 0).toBe(available);
  });
});

it("propagates an available host refiner failure", () => {
  const failure = new Error("synthetic host refiner failure");
  sdk.available = true;
  sdk.failure = failure;
  expect(() => DiscordConfigSchema.parse({})).toThrow(failure);
});
