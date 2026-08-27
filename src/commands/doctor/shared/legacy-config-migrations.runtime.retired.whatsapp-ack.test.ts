import { describe, expect, it } from "vitest";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED } from "./legacy-config-migrations.runtime.retired.js";

function applyRetired(raw: Record<string, unknown>) {
  const changes: string[] = [];
  for (const migration of LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED) {
    migration.apply(raw, changes);
  }
  return { raw, changes };
}

function whatsappAckConfig(
  rootAckReaction: Record<string, unknown>,
  accountAckReaction?: Record<string, unknown>,
  messages?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...(messages ? { messages } : {}),
    channels: {
      whatsapp: {
        ackReaction: rootAckReaction,
        ...(accountAckReaction ? { accounts: { work: { ackReaction: accountAckReaction } } } : {}),
      },
    },
  };
}

const rootMove =
  "Moved translatable channels.whatsapp.ackReaction settings to messages ack settings.";
const accountMove =
  "Moved translatable channels.whatsapp.accounts.work.ackReaction settings to messages ack settings.";

function expectUnrepresentableScopeChange(
  changes: string[],
  path: string,
  effectiveScope: string,
): void {
  const change = changes.find((line) => line.startsWith(`${path} acknowledged direct messages`));
  expect(change).toEqual(expect.stringContaining(effectiveScope));
  expect(change).toEqual(expect.stringContaining('"direct" acknowledges direct messages'));
  expect(change).toEqual(expect.stringContaining('"all" acknowledges direct messages'));
}

describe("retired WhatsApp ack reaction migration", () => {
  it.each([
    {
      name: "reports an explicit legacy scope with no canonical equivalent",
      raw: whatsappAckConfig({ emoji: "👀", direct: true, group: "mentions" }),
      path: "channels.whatsapp.ackReaction",
      finalScope: undefined,
      effectiveScope:
        'The default "group-mentions" scope now applies and stops acknowledging direct messages.',
    },
    {
      name: "reports the same unrepresentable legacy defaults when omitted",
      raw: whatsappAckConfig({ emoji: "👀" }),
      path: "channels.whatsapp.ackReaction",
      finalScope: undefined,
      effectiveScope:
        'The default "group-mentions" scope now applies and stops acknowledging direct messages.',
    },
    {
      name: "reports the final scope selected by a later account",
      raw: whatsappAckConfig(
        { emoji: "👀", direct: true, group: "mentions" },
        { emoji: "👀", direct: true, group: "never" },
      ),
      path: "channels.whatsapp.ackReaction",
      finalScope: "direct",
      effectiveScope:
        'The final messages.ackReactionScope value "direct" now decides WhatsApp acknowledgements instead of the deleted legacy pair.',
    },
    {
      name: "reports a pre-existing final scope",
      raw: whatsappAckConfig({ emoji: "👀", direct: true, group: "mentions" }, undefined, {
        ackReactionScope: "all",
      }),
      path: "channels.whatsapp.ackReaction",
      finalScope: "all",
      effectiveScope:
        'The final messages.ackReactionScope value "all" now decides WhatsApp acknowledgements instead of the deleted legacy pair.',
    },
    {
      name: "reports the account path after the root selects the final scope",
      raw: whatsappAckConfig(
        { emoji: "👀", direct: false, group: "always" },
        { emoji: "👀", direct: true, group: "mentions" },
      ),
      path: "channels.whatsapp.accounts.work.ackReaction",
      finalScope: "group-all",
      effectiveScope:
        'The final messages.ackReactionScope value "group-all" now decides WhatsApp acknowledgements instead of the deleted legacy pair.',
    },
  ])("$name", ({ raw, path, finalScope, effectiveScope }) => {
    const result = applyRetired(raw);

    expect(result.raw).not.toHaveProperty(path);
    if (finalScope === undefined) {
      expect(result.raw).not.toHaveProperty("messages.ackReactionScope");
    } else {
      expect(result.raw).toHaveProperty("messages.ackReactionScope", finalScope);
    }
    expectUnrepresentableScopeChange(result.changes, path, effectiveScope);
  });

  it.each([
    {
      name: "an earlier legacy entry wins",
      raw: whatsappAckConfig(
        { emoji: "👀", direct: false, group: "always" },
        { emoji: "👀", direct: true, group: "never" },
      ),
      path: "channels.whatsapp.accounts.work.ackReaction",
      finalScope: "group-all",
    },
    {
      name: "a canonical scope wins",
      raw: whatsappAckConfig({ emoji: "👀", direct: true, group: "never" }, undefined, {
        ackReactionScope: "group-mentions",
      }),
      path: "channels.whatsapp.ackReaction",
      finalScope: "group-mentions",
    },
  ])("reports when $name over a different representable scope", ({ raw, path, finalScope }) => {
    const result = applyRetired(raw);

    expect(result.raw).toHaveProperty("messages.ackReactionScope", finalScope);
    expect(result.changes.join("\n")).toEqual(
      expect.stringContaining(
        `${path} requested the "direct" scope, but the final messages.ackReactionScope is ${JSON.stringify(finalScope)}`,
      ),
    );
  });

  it.each([
    {
      name: "a single representable scope",
      raw: whatsappAckConfig({ emoji: "👀", direct: true, group: "never" }),
      finalScope: "direct",
      expectedChanges: [rootMove],
    },
    {
      name: "matching root and account scopes",
      raw: whatsappAckConfig(
        { emoji: "👀", direct: true, group: "never" },
        { emoji: "👀", direct: true, group: "never" },
      ),
      finalScope: "direct",
      expectedChanges: [rootMove, accountMove],
    },
    {
      name: 'equivalent "off" and "none" scopes',
      raw: whatsappAckConfig({ emoji: "👀", direct: false, group: "never" }, undefined, {
        ackReactionScope: "none",
      }),
      finalScope: "none",
      expectedChanges: [rootMove],
    },
  ])("keeps $name quiet", ({ raw, finalScope, expectedChanges }) => {
    const result = applyRetired(raw);

    expect(result.raw).toHaveProperty("messages.ackReactionScope", finalScope);
    expect(result.changes).toStrictEqual(expectedChanges);
  });
});
