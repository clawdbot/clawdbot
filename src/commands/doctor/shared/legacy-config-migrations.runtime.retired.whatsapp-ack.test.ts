import { describe, expect, it } from "vitest";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED } from "./legacy-config-migrations.runtime.retired.js";

function applyRetired(raw: Record<string, unknown>) {
  const changes: string[] = [];
  for (const migration of LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED) {
    migration.apply(raw, changes);
  }
  return { raw, changes };
}

const MOVED_CHANGE =
  "Moved translatable channels.whatsapp.ackReaction settings to messages ack settings.";

const UNREPRESENTABLE_PREFIX =
  "channels.whatsapp.ackReaction acknowledged direct messages plus mentioned groups, and messages.ackReactionScope has no value for that combination.";

const UNREPRESENTABLE_SUFFIX =
  'No scope keeps both: "direct" acknowledges direct messages but stops acknowledging mentioned groups, and "all" acknowledges direct messages but also acknowledges every group message. messages.ackReactionScope is the global fallback, so changing it also changes acknowledgements on every other channel that has no acknowledgement scope of its own.';

const DEFAULT_SCOPE_CHANGE = `${UNREPRESENTABLE_PREFIX} The default "group-mentions" scope now applies and stops acknowledging direct messages. ${UNREPRESENTABLE_SUFFIX}`;

function keptScopeChange(scope: string) {
  return `${UNREPRESENTABLE_PREFIX} The existing messages.ackReactionScope value "${scope}" was kept, so it decides WhatsApp acknowledgements instead of the deleted legacy pair. ${UNREPRESENTABLE_SUFFIX}`;
}

describe("retired WhatsApp ack reaction migration", () => {
  it("flags the legacy ack combination no canonical scope represents", () => {
    const result = applyRetired({
      channels: {
        whatsapp: { ackReaction: { emoji: "👀", direct: true, group: "mentions" } },
      },
    });

    expect(result.raw).not.toHaveProperty("channels.whatsapp.ackReaction");
    expect(result.raw).toHaveProperty("messages.ackReaction", "👀");
    expect(result.raw).not.toHaveProperty("messages.ackReactionScope");
    expect(result.changes).toStrictEqual([MOVED_CHANGE, DEFAULT_SCOPE_CHANGE]);
  });

  it("flags the emoji-only legacy ack object that inherits both defaults", () => {
    const result = applyRetired({
      channels: { whatsapp: { ackReaction: { emoji: "👀" } } },
    });

    expect(result.raw).not.toHaveProperty("messages.ackReactionScope");
    expect(result.changes).toContain(DEFAULT_SCOPE_CHANGE);
  });

  it("names both lossy recovery scopes and the fallback reach of the shared scope", () => {
    const result = applyRetired({
      channels: {
        whatsapp: { ackReaction: { emoji: "👀", direct: true, group: "mentions" } },
      },
    });
    const warning = result.changes.at(-1) ?? "";

    expect(warning).toContain(
      '"direct" acknowledges direct messages but stops acknowledging mentioned groups',
    );
    expect(warning).toContain(
      '"all" acknowledges direct messages but also acknowledges every group message',
    );
    expect(warning).toContain(
      "messages.ackReactionScope is the global fallback, so changing it also changes acknowledgements on every other channel that has no acknowledgement scope of its own",
    );
  });

  it("migrates representable legacy ack scopes without extra notes", () => {
    const result = applyRetired({
      channels: {
        whatsapp: { ackReaction: { emoji: "👀", direct: true, group: "never" } },
      },
    });

    expect(result.raw).toHaveProperty("messages.ackReactionScope", "direct");
    expect(result.changes).toStrictEqual([MOVED_CHANGE]);
  });

  it.each(["all", "direct", "group-mentions", "off"])(
    "reports the retained %s scope instead of claiming a lossless move",
    (scope) => {
      const result = applyRetired({
        messages: { ackReactionScope: scope },
        channels: {
          whatsapp: { ackReaction: { emoji: "👀", direct: true, group: "mentions" } },
        },
      });

      expect(result.raw).toHaveProperty("messages.ackReactionScope", scope);
      expect(result.changes).toStrictEqual([MOVED_CHANGE, keptScopeChange(scope)]);
    },
  );

  it("keeps a canonical scope quiet when the legacy pair is representable", () => {
    const result = applyRetired({
      messages: { ackReactionScope: "all" },
      channels: {
        whatsapp: { ackReaction: { emoji: "👀", direct: false, group: "always" } },
      },
    });

    expect(result.raw).toHaveProperty("messages.ackReactionScope", "all");
    expect(result.changes).toStrictEqual([MOVED_CHANGE]);
  });
});
