import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadOpenClawPlugins } from "./loader.js";

describe("source checkout bundled plugin runtime", () => {
  it("loads enabled bundled plugins from built dist or source checkout", () => {
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

    const builtRuntime = path.join(process.cwd(), "dist", "extensions", "twitch", "index.js");
    const expectedRuntime = fs.existsSync(builtRuntime)
      ? `${path.sep}dist${path.sep}extensions${path.sep}twitch${path.sep}index.js`
      : `${path.sep}extensions${path.sep}twitch${path.sep}index.ts`;
    const expectedRoot = fs.existsSync(builtRuntime)
      ? `${path.sep}dist${path.sep}extensions${path.sep}twitch`
      : `${path.sep}extensions${path.sep}twitch`;

    expect(twitch?.source).toContain(expectedRuntime);
    expect(twitch?.rootDir).toContain(expectedRoot);
  });
});
