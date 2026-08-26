import { describe, expect, it } from "vitest";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED } from "./legacy-config-migrations.runtime.retired.js";

function applyRetired(raw: Record<string, unknown>) {
  const changes: string[] = [];
  for (const migration of LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED) {
    migration.apply(raw, changes);
  }
  return { raw, changes };
}

function unrepresentableScopeChange(path: string, effectiveScope: string): string {
  return `${path} acknowledged direct messages plus mentioned groups, and messages.ackReactionScope has no value for that combination. ${effectiveScope} No shared scope keeps both: "direct" acknowledges direct messages but stops acknowledging mentioned groups, and "all" acknowledges direct messages but also acknowledges every group message. messages.ackReactionScope is the global fallback for channels without an acknowledgement scope of their own.`;
}

describe("retired WhatsApp ack reaction migration", () => {
  it.each([
    { ackReaction: { emoji: "👀", direct: true, group: "mentions" } },
    { ackReaction: { emoji: "👀" } },
  ])("reports the legacy scope that has no canonical equivalent", (whatsapp) => {
    const result = applyRetired({ channels: { whatsapp } });

    expect(result.raw).not.toHaveProperty("channels.whatsapp.ackReaction");
    expect(result.raw).toHaveProperty("messages.ackReaction", "👀");
    expect(result.raw).not.toHaveProperty("messages.ackReactionScope");
    expect(result.changes).toContain(
      unrepresentableScopeChange(
        "channels.whatsapp.ackReaction",
        'The default "group-mentions" scope now applies and stops acknowledging direct messages.',
      ),
    );
  });

  it("reports the final scope after later account migrations", () => {
    const result = applyRetired({
      channels: {
        whatsapp: {
          ackReaction: { emoji: "👀", direct: true, group: "mentions" },
          accounts: {
            work: { ackReaction: { emoji: "✅", direct: true, group: "never" } },
          },
        },
      },
    });

    expect(result.raw).toHaveProperty("messages.ackReactionScope", "direct");
    expect(result.changes).toContain(
      unrepresentableScopeChange(
        "channels.whatsapp.ackReaction",
        'The final messages.ackReactionScope value "direct" now decides WhatsApp acknowledgements instead of the deleted legacy pair.',
      ),
    );
    expect(result.changes.join("\n")).not.toContain(
      'The default "group-mentions" scope now applies',
    );
  });

  it("reports a pre-existing final scope", () => {
    const result = applyRetired({
      messages: { ackReactionScope: "all" },
      channels: {
        whatsapp: { ackReaction: { emoji: "👀", direct: true, group: "mentions" } },
      },
    });

    expect(result.raw).toHaveProperty("messages.ackReactionScope", "all");
    expect(result.changes).toContain(
      unrepresentableScopeChange(
        "channels.whatsapp.ackReaction",
        'The final messages.ackReactionScope value "all" now decides WhatsApp acknowledgements instead of the deleted legacy pair.',
      ),
    );
  });

  it("reports the account path after an earlier root migration sets the final scope", () => {
    const result = applyRetired({
      channels: {
        whatsapp: {
          ackReaction: { emoji: "👀", direct: false, group: "always" },
          accounts: {
            work: { ackReaction: { emoji: "✅", direct: true, group: "mentions" } },
          },
        },
      },
    });

    expect(result.raw).toHaveProperty("messages.ackReactionScope", "group-all");
    expect(result.changes).toContain(
      unrepresentableScopeChange(
        "channels.whatsapp.accounts.work.ackReaction",
        'The final messages.ackReactionScope value "group-all" now decides WhatsApp acknowledgements instead of the deleted legacy pair.',
      ),
    );
  });

  it("migrates representable legacy scopes without an extra note", () => {
    const result = applyRetired({
      channels: {
        whatsapp: { ackReaction: { emoji: "👀", direct: true, group: "never" } },
      },
    });

    expect(result.raw).toHaveProperty("messages.ackReactionScope", "direct");
    expect(result.changes).toStrictEqual([
      "Moved translatable channels.whatsapp.ackReaction settings to messages ack settings.",
    ]);
  });
});
