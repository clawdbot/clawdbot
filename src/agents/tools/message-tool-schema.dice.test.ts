// Scoped tool schemas prune parameters the selected actions do not use, and merge the
// surviving groups into one flat object. Without a group of its own `dice` advertised no
// face at all; sharing the reaction group's `emoji` key would have retitled that parameter
// for `react` whenever both actions are enabled.
import { describe, expect, it } from "vitest";
import { buildMessageToolSchemaFromActions } from "./message-tool-schema-scoping.js";
import { MESSAGE_TOOL_SCHEMA_BUILDERS } from "./message-tool-schema.js";

const OPTIONS = {
  includeDeliveryPin: false,
  includeBestEffort: false,
  scopeToActions: true,
} as const;

function schemaPropertiesFor(actions: readonly string[]) {
  const schema = buildMessageToolSchemaFromActions(
    actions,
    OPTIONS as never,
    MESSAGE_TOOL_SCHEMA_BUILDERS,
  );
  return (schema as { properties?: Record<string, { description?: string }> }).properties ?? {};
}

function propertiesFor(actions: readonly string[]) {
  return Object.keys(schemaPropertiesFor(actions));
}

describe("dice schema scoping", () => {
  it("advertises the dice face when dice is in scope", () => {
    expect(propertiesFor(["dice"])).toContain("diceEmoji");
  });

  it("does not drag reaction-only parameters into a dice-only schema", () => {
    const properties = propertiesFor(["dice"]);
    expect(properties).not.toContain("remove");
    expect(properties).not.toContain("trackToolCalls");
  });

  it("leaves the reaction emoji description intact when both actions are enabled", () => {
    const properties = schemaPropertiesFor(["react", "dice"]);
    expect(properties.emoji?.description).toBe(
      "Unicode emoji; channels may also support custom emoji.",
    );
    expect(properties.diceEmoji?.description).toContain("Dice face");
  });
});
