import { beforeEach, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { getChannelMessageAdapter } from "./channel-adapters.js";

class TestTextDisplay {
  constructor(readonly content: string) {}
}

class TestSeparator {
  constructor(readonly options: { divider: boolean; spacing: string }) {}
}

class TestRichUiContainer {
  constructor(readonly components: Array<TestTextDisplay | TestSeparator>) {}
}

const richCrossContextPlugin: Pick<
  ChannelPlugin,
  "id" | "meta" | "capabilities" | "config" | "messaging"
> = {
  ...createChannelTestPluginBase({ id: "rich-chat" }),
  messaging: {
    buildCrossContextComponents: ({ originLabel, message, cfg, accountId }) => {
      const trimmed = message.trim();
      const components: Array<TestTextDisplay | TestSeparator> = [];
      if (trimmed) {
        components.push(new TestTextDisplay(message));
        components.push(new TestSeparator({ divider: true, spacing: "small" }));
      }
      components.push(new TestTextDisplay(`*From ${originLabel}*`));
      void cfg;
      void accountId;
      return [new TestRichUiContainer(components)];
    },
  },
};

describe("getChannelMessageAdapter", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "rich-chat", plugin: richCrossContextPlugin, source: "test" },
        {
          pluginId: "plain-chat",
          plugin: createChannelTestPluginBase({ id: "plain-chat" }),
          source: "test",
        },
      ]),
    );
  });

  it("returns the default adapter for channels without structured component support", () => {
    expect(getChannelMessageAdapter("plain-chat")).toEqual({
      supportsComponentsV2: false,
    });
  });

  it("returns an adapter with a cross-context component builder", () => {
    const adapter = getChannelMessageAdapter("rich-chat");

    expect(adapter.supportsComponentsV2).toBe(true);
    expect(adapter.buildCrossContextComponents).toBeTypeOf("function");

    const components = adapter.buildCrossContextComponents?.({
      originLabel: "Forum",
      message: "Hello from chat",
      cfg: {} as never,
      accountId: "primary",
    });
    const container = components?.[0] as TestRichUiContainer | undefined;

    expect(components).toHaveLength(1);
    expect(container).toBeInstanceOf(TestRichUiContainer);
    expect(container?.components).toEqual([
      expect.any(TestTextDisplay),
      expect.any(TestSeparator),
      expect.any(TestTextDisplay),
    ]);
  });

  it.each([
    {
      message: "Hello from chat",
      originLabel: "Forum",
      accountId: "primary",
      expectedComponents: [
        expect.any(TestTextDisplay),
        expect.any(TestSeparator),
        expect.any(TestTextDisplay),
      ],
    },
    {
      message: "   ",
      originLabel: "Pager",
      expectedComponents: [expect.any(TestTextDisplay)],
    },
  ])(
    "builds cross-context components for %j",
    ({ message, originLabel, accountId, expectedComponents }) => {
      const adapter = getChannelMessageAdapter("rich-chat");
      const components = adapter.buildCrossContextComponents?.({
        originLabel,
        message,
        cfg: {} as never,
        ...(accountId ? { accountId } : {}),
      });
      const container = components?.[0] as TestRichUiContainer | undefined;

      expect(components).toHaveLength(1);
      expect(container?.components).toEqual(expectedComponents);
    },
  );
});
