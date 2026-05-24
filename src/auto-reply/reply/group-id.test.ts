import { afterEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { extractSimpleExplicitGroupId } from "./group-id-simple.js";
import { extractExplicitGroupId } from "./group-id.js";

afterEach(() => {
  setActivePluginRegistry(createTestRegistry());
});

describe("extractSimpleExplicitGroupId", () => {
  it("returns undefined for empty/null input", () => {
    expect(extractSimpleExplicitGroupId(undefined)).toBeUndefined();
    expect(extractSimpleExplicitGroupId(null)).toBeUndefined();
    expect(extractSimpleExplicitGroupId("")).toBeUndefined();
    expect(extractSimpleExplicitGroupId("  ")).toBeUndefined();
  });

  it("extracts group ID from provider group format", () => {
    expect(extractSimpleExplicitGroupId("chat:group:-1003776849159")).toBe("-1003776849159");
  });

  it("extracts group ID from provider topic format, stripping topic suffix", () => {
    expect(extractSimpleExplicitGroupId("chat:group:-1003776849159:topic:1264")).toBe(
      "-1003776849159",
    );
  });

  it("extracts group ID from channel format", () => {
    expect(extractSimpleExplicitGroupId("chat:channel:-1001234567890")).toBe("-1001234567890");
  });

  it("extracts group ID from channel format with topic", () => {
    expect(extractSimpleExplicitGroupId("chat:channel:-1001234567890:topic:42")).toBe(
      "-1001234567890",
    );
  });

  it("extracts group ID from bare group: prefix", () => {
    expect(extractSimpleExplicitGroupId("group:-1003776849159")).toBe("-1003776849159");
  });

  it("extracts group ID from bare group: prefix with topic", () => {
    expect(extractSimpleExplicitGroupId("group:-1003776849159:topic:999")).toBe("-1003776849159");
  });

  it("returns undefined for unrecognized formats", () => {
    expect(extractSimpleExplicitGroupId("user:12345")).toBeUndefined();
    expect(extractSimpleExplicitGroupId("just-a-string")).toBeUndefined();
  });
});

describe("extractExplicitGroupId", () => {
  it("strips Telegram numeric topic shorthand after target normalization", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({
              id: "telegram",
              capabilities: { chatTypes: ["group"] },
            }),
            messaging: {
              normalizeTarget: () => "telegram:-100200300:77",
              inferTargetChatType: () => "group",
            },
          },
        },
      ]),
    );

    expect(extractExplicitGroupId("telegram:-100200300:77")).toBe("-100200300");
  });

  it("keeps legacy parser-only group target extraction quarantined", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "legacygroup",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({
              id: "legacygroup",
              capabilities: { chatTypes: ["group"] },
            }),
            messaging: {
              parseExplicitTarget: ({ raw }: { raw: string }) =>
                raw.startsWith("legacygroup:")
                  ? { to: "group:room-a:topic:77", chatType: "group" as const }
                  : null,
            },
          },
        },
      ]),
    );

    expect(extractExplicitGroupId("legacygroup:room-a:topic:77")).toBe("room-a");
  });
});
