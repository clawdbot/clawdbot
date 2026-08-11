// #120332 round 53 (P2): channel default hydration can oscillate — an incumbent's default
// materializes a channel whose replanned owner supplies no default, and the de-hydrated record
// elects the incumbent again. No fixpoint exists, and the pass bound must not silently accept
// whichever parity it expired on: the loop settles deterministically on the AUTHORED record's
// owners, the config the gateway consumes before any default sticks.
import { describe, expect, it } from "vitest";
import {
  type ChannelSchemaOwnerEntry,
  settleDefaultedChannelSchemas,
} from "./validation-channel-defaults.js";

const DEFAULTED_SCHEMA = {
  type: "object",
  properties: { opt: { type: "string", default: "v" } },
  additionalProperties: false,
};
const PLAIN_SCHEMA = {
  type: "object",
  properties: { other: { type: "string" } },
  additionalProperties: false,
};

function schemasOf(entry: ChannelSchemaOwnerEntry): Map<string, ChannelSchemaOwnerEntry> {
  return new Map([["osc", entry]]);
}

describe("settleDefaultedChannelSchemas", () => {
  it("converges on a stable hydrated record", () => {
    const initial = schemasOf({ schema: DEFAULTED_SCHEMA, pluginId: "acme-inc" });
    const builds: string[] = [];
    const settled = settleDefaultedChannelSchemas({
      channelsRecord: { osc: {} },
      compatChannels: { osc: {} },
      initialSchemas: initial,
      buildSchemas: (channels) => {
        builds.push(JSON.stringify(channels));
        // The hydrated record keeps electing the same defaulted owner: a true fixpoint.
        return schemasOf({ schema: DEFAULTED_SCHEMA, pluginId: "acme-inc" });
      },
    });

    expect(settled.get("osc")?.pluginId).toBe("acme-inc");
    // One rebuild at the hydrated record, then the fixpoint equality exits.
    expect(builds).toEqual([JSON.stringify({ osc: { opt: "v" } })]);
  });

  it("settles an oscillation on the authored record's owners", () => {
    // The schemaless second channel only widens the pass bound, so a parity-retaining loop
    // demonstrably expires on the hydrated build instead of the authored one.
    const authoredJson = JSON.stringify({ osc: {}, pad: {} });
    const initial = schemasOf({ schema: DEFAULTED_SCHEMA, pluginId: "acme-inc" });
    const settled = settleDefaultedChannelSchemas({
      channelsRecord: { osc: {}, pad: {} },
      compatChannels: { osc: {}, pad: {} },
      initialSchemas: initial,
      buildSchemas: (channels) =>
        // The hydrated record elects a no-default replacement; the de-hydrated (authored)
        // record elects the defaulted incumbent again — a two-cycle with no fixpoint.
        JSON.stringify(channels) === authoredJson
          ? schemasOf({ schema: DEFAULTED_SCHEMA, pluginId: "acme-inc" })
          : schemasOf({ schema: PLAIN_SCHEMA, pluginId: "acme-rep" }),
    });

    expect(settled.get("osc")?.pluginId).toBe("acme-inc");
  });
});
