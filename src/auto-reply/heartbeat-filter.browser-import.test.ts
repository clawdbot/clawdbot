import { build } from "esbuild";
import { describe, expect, it } from "vitest";

describe("heartbeat-filter browser import", () => {
  it("does not pull node-only utils into browser bundles", async () => {
    const bundled = await build({
      bundle: true,
      format: "esm",
      metafile: true,
      platform: "browser",
      stdin: {
        contents: [
          'import { isHeartbeatOkResponse } from "./src/auto-reply/heartbeat-filter.ts";',
          "globalThis.__heartbeatOk = isHeartbeatOkResponse;",
        ].join("\n"),
        loader: "ts",
        resolveDir: process.cwd(),
        sourcefile: "heartbeat-filter-browser-entry.ts",
      },
      write: false,
    });

    expect(Object.keys(bundled.metafile.inputs)).not.toContain("src/utils.ts");
  });
});
