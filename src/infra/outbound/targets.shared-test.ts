import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { resolveOutboundTarget } from "./targets.js";
import {
  createForumTargetTestPlugin,
  createGenericTargetTestPlugin,
  createTargetsTestRegistry,
  createTestChannelPlugin,
} from "./targets.test-helpers.js";

export function installResolveOutboundTargetPluginRegistryHooks(): void {
  beforeEach(() => {
    setActivePluginRegistry(
      createTargetsTestRegistry([
        createGenericTargetTestPlugin("alpha", "Alpha"),
        createGenericTargetTestPlugin("beta", "Beta"),
        createForumTargetTestPlugin(),
      ]),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(createTargetsTestRegistry([]));
  });
}

export function runResolveOutboundTargetCoreTests(): void {
  describe("resolveOutboundTarget", () => {
    installResolveOutboundTargetPluginRegistryHooks();

    it("rejects empty targets through the loaded channel plugin", () => {
      const cfg = {
        channels: { alpha: { allowFrom: ["room-one"] } },
      };
      const res = resolveOutboundTarget({
        channel: "alpha",
        to: "",
        cfg,
        mode: "explicit",
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.message).toContain("Alpha");
      }
    });

    it.each([
      {
        name: "normalizes target through the loaded plugin",
        input: { channel: "alpha" as const, to: " Alpha:Room One " },
        expected: { ok: true as const, to: "room-one" },
      },
      {
        name: "uses channel defaultTo when no target was provided",
        input: {
          channel: "beta" as const,
          to: "",
          cfg: { channels: { beta: { defaultTo: "Beta:Default Room" } } },
        },
        expected: { ok: true as const, to: "default-room" },
      },
      {
        name: "passes explicit allowFrom without using it as an implicit target",
        input: {
          channel: "alpha" as const,
          to: "",
          allowFrom: ["alpha:room-one"],
        },
        expectedErrorIncludes: "Alpha",
      },
      {
        name: "rejects plugin-specific invalid targets",
        input: { channel: "alpha" as const, to: "invalid" },
        expectedErrorIncludes: "Alpha",
      },
    ])("$name", ({ input, expected, expectedErrorIncludes }) => {
      const res = resolveOutboundTarget(input);
      if (expected) {
        expect(res).toEqual(expected);
        return;
      }
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.message).toContain(expectedErrorIncludes);
      }
    });

    it("uses the plugin hint when a channel has outbound support but no target resolver", () => {
      setActivePluginRegistry(
        createTargetsTestRegistry([
          createForumTargetTestPlugin(),
          createTestChannelPlugin({
            id: "noresolver",
            label: "NoResolver",
            outbound: {
              deliveryMode: "direct",
              sendText: async () => ({ channel: "noresolver", messageId: "noresolver-msg" }),
            },
            messaging: {
              targetResolver: { hint: "<test-target>" },
            },
          }),
        ]),
      );

      const res = resolveOutboundTarget({ channel: "noresolver", to: " " });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.message).toContain("NoResolver");
      }
    });

    it("rejects webchat delivery", () => {
      const res = resolveOutboundTarget({ channel: "webchat", to: "x" });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.message).toContain("WebChat");
      }
    });
  });
}
