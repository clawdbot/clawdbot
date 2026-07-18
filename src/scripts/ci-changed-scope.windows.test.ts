// Windows CI scope tests cover paths with platform-specific runtime contracts.
import { describe, expect, it } from "vitest";

const { detectChangedScope } = await import("../../scripts/ci-changed-scope.mjs");

describe("detectChangedScope Windows routing", () => {
  it("routes SQLite transcript archive changes to Windows", () => {
    for (const archivePath of [
      "src/config/sessions/session-accessor.sqlite-archive.ts",
      "src/config/sessions/store.session-lifecycle-mutation.test.ts",
    ]) {
      expect(detectChangedScope([archivePath]), archivePath).toMatchObject({
        runNode: true,
        runWindows: true,
      });
    }
  });
});
