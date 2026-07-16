import { beforeAll, describe, expect, it } from "vitest";

let buildDiscordComponentCustomId: typeof import("../components.js").buildDiscordComponentCustomId;
let buildDiscordModalCustomId: typeof import("../components.js").buildDiscordModalCustomId;
let createDiscordComponentButton: typeof import("./agent-components.js").createDiscordComponentButton;
let createDiscordComponentChannelSelect: typeof import("./agent-components.js").createDiscordComponentChannelSelect;
let createDiscordComponentMentionableSelect: typeof import("./agent-components.js").createDiscordComponentMentionableSelect;
let createDiscordComponentModal: typeof import("./agent-components.js").createDiscordComponentModal;
let createDiscordComponentRoleSelect: typeof import("./agent-components.js").createDiscordComponentRoleSelect;
let createDiscordComponentStringSelect: typeof import("./agent-components.js").createDiscordComponentStringSelect;
let createDiscordComponentUserSelect: typeof import("./agent-components.js").createDiscordComponentUserSelect;

beforeAll(async () => {
  ({ buildDiscordComponentCustomId, buildDiscordModalCustomId } = await import("../components.js"));
  ({
    createDiscordComponentButton,
    createDiscordComponentChannelSelect,
    createDiscordComponentMentionableSelect,
    createDiscordComponentModal,
    createDiscordComponentRoleSelect,
    createDiscordComponentStringSelect,
    createDiscordComponentUserSelect,
  } = await import("./agent-components.js"));
});

type WildcardComponent = {
  customId: string;
  customIdParser: (id: string) => { key: string; data: unknown };
};

function asWildcardComponent(value: unknown): WildcardComponent {
  return value as WildcardComponent;
}

function createWildcardComponents() {
  const context = {} as Parameters<typeof createDiscordComponentButton>[0];
  return [
    asWildcardComponent(createDiscordComponentButton(context)),
    asWildcardComponent(createDiscordComponentStringSelect(context)),
    asWildcardComponent(createDiscordComponentUserSelect(context)),
    asWildcardComponent(createDiscordComponentRoleSelect(context)),
    asWildcardComponent(createDiscordComponentMentionableSelect(context)),
    asWildcardComponent(createDiscordComponentChannelSelect(context)),
    asWildcardComponent(createDiscordComponentModal(context)),
  ];
}

describe("discord wildcard component registration ids", () => {
  it("uses distinct sentinel customIds instead of a shared literal wildcard", () => {
    const components = createWildcardComponents();
    const customIds = components.map((component) => component.customId);

    expect(customIds.every((id) => id !== "*")).toBe(true);
    expect(new Set(customIds).size).toBe(customIds.length);
  });

  it("still resolves sentinel ids and runtime ids through wildcard parser key", () => {
    const components = createWildcardComponents();
    const interactionCustomId = buildDiscordComponentCustomId({ componentId: "sel_test" });
    const interactionModalId = buildDiscordModalCustomId("mdl_test");

    for (const component of components) {
      expect(component.customIdParser(component.customId).key).toBe("*");
      if (component.customId.includes("_modal_")) {
        expect(component.customIdParser(interactionModalId).key).toBe("*");
      } else {
        expect(component.customIdParser(interactionCustomId).key).toBe("*");
      }
    }
  });
});
