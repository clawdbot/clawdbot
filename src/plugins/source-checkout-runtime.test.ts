import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadOpenClawPlugins } from "./loader.js";

describe("source checkout bundled plugin runtime", () => {
  it("loads enabled bundled plugins from the pnpm workspace source tree", () => {
    const registry = loadOpenClawPlugins({
      cache: false,
      onlyPluginIds: ["twitch"],
      config: {
        plugins: {
          entries: {
            twitch: { enabled: true },
          },
        },
      },
    });

    const twitch = registry.plugins.find((plugin) => plugin.id === "twitch");
    expect(twitch).toMatchObject({
      status: "loaded",
      origin: "bundled",
    });
    expect(twitch?.source).toContain(`${path.sep}extensions${path.sep}twitch${path.sep}index.ts`);
    expect(twitch?.rootDir).toContain(`${path.sep}extensions${path.sep}twitch`);
  });
});
