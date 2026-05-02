import { runDirectImportSmoke } from "openclaw/plugin-sdk/plugin-test-contracts";
import { describe, expect, it } from "vitest";

describe("zalo runtime api", () => {
  it("loads the narrow runtime api without reentering setup surfaces", async () => {
    const stdout = await runDirectImportSmoke(
      `const runtime = await import("./extensions/zalo/runtime-api.ts");
process.stdout.write(JSON.stringify({
  hasZaloPlugin: Object.hasOwn(runtime, "zaloPlugin"),
  hasZaloSetupWizard: Object.hasOwn(runtime, "zaloSetupWizard"),
  type: typeof runtime.setZaloRuntime,
}));`,
    );

    expect(stdout).toBe('{"hasZaloPlugin":false,"hasZaloSetupWizard":false,"type":"function"}');
  }, 45_000);
});
