import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadRuntimeApiExportTypesViaJiti } from "../../test/helpers/plugins/jiti-runtime-api.js";

describe("zalo runtime api", () => {
  it("loads the narrow runtime api without reentering setup surfaces", () => {
    const runtimeApiPath = path.join(process.cwd(), "extensions", "zalo", "runtime-api.ts");

    expect(
      loadRuntimeApiExportTypesViaJiti({
        modulePath: runtimeApiPath,
        exportNames: ["setZaloRuntime"],
        realPluginSdkSpecifiers: ["openclaw/plugin-sdk/runtime-store"],
      }),
    ).toEqual({
      setZaloRuntime: "function",
    });
  });
});
