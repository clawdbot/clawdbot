// WhatsApp plugin manifest tests cover public metadata that must mirror runtime config.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(
  readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
) as {
  configSchema?: {
    properties?: {
      pluginHooks?: {
        properties?: Record<string, unknown>;
      };
    };
  };
};

describe("WhatsApp plugin manifest", () => {
  it("declares the poll-vote hook opt-in accepted by the runtime schema", () => {
    expect(manifest.configSchema?.properties?.pluginHooks?.properties?.pollVoteReceived).toEqual({
      type: "boolean",
      description:
        "Opt in to broadcasting decoded votes on OpenClaw-created WhatsApp polls to loaded plugins.",
    });
  });
});
