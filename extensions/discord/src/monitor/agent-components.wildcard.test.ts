// Discord tests cover agent components.wildcard plugin behavior.
import { beforeAll, describe, expect, it } from "vitest";

let buildDiscordComponentCustomId: typeof import("../components.js").buildDiscordComponentCustomId;
let buildDiscordModalCustomId: typeof import("../components.js").buildDiscordModalCustomId;
type DiscordComponentFactory =
  (typeof import("./agent-components.js").createDiscordComponentControls)[number];
let createDiscordComponentButton: DiscordComponentFactory;
let createDiscordComponentChannelSelect: DiscordComponentFactory;
let createDiscordComponentMentionableSelect: DiscordComponentFactory;
let createDiscordComponentModal: typeof import("./agent-components.js").createDiscordComponentModal;
let createDiscordComponentRoleSelect: DiscordComponentFactory;
let createDiscordComponentStringSelect: DiscordComponentFactory;
let createDiscordComponentUserSelect: DiscordComponentFactory;

function requireComponentFactory(
  factories: readonly DiscordComponentFactory[],
  index: number,
): DiscordComponentFactory {
  const factory = factories[index];
  if (!factory) {
    throw new Error(`missing Discord component factory ${index}`);
  }
  return factory;
}

beforeAll(async () => {
  ({ buildDiscordComponentCustomId, buildDiscordModalCustomId } = await import("../components.js"));
  const components = await import("./agent-components.js");
  ({ createDiscordComponentModal } = components);
  createDiscordComponentButton = requireComponentFactory(
    components.createDiscordComponentControls,
    0,
  );
  createDiscordComponentStringSelect = requireComponentFactory(
    components.createDiscordComponentControls,
    1,
  );
  createDiscordComponentUserSelect = requireComponentFactory(
    components.createDiscordComponentControls,
    2,
  );
  createDiscordComponentRoleSelect = requireComponentFactory(
    components.createDiscordComponentControls,
    3,
  );
  createDiscordComponentMentionableSelect = requireComponentFactory(
    components.createDiscordComponentControls,
    4,
  );
  createDiscordComponentChannelSelect = requireComponentFactory(
    components.createDiscordComponentControls,
    5,
  );
});

type WildcardComponent = {
  customId: string;
  customIdParser: (id: string) => { key: string; data: unknown };
};

function asWildcardComponent(value: unknown): WildcardComponent {
  return value as WildcardComponent;
}

function createWildcardComponents() {
  const context = {} as Parameters<DiscordComponentFactory>[0];
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

    expect(customIds.some((id) => id === "*")).toBe(false);
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
