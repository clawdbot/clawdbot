import { describe, expect, it } from "vitest";
import {
  checkNativeStateSchemaVersion,
  compareNativeStateSchemaVersions,
} from "../../scripts/check-native-state-schema-version.mjs";

describe("native state schema version guard", () => {
  it("keeps the checked-in Swift and TypeScript contracts aligned", () => {
    expect(checkNativeStateSchemaVersion()).toBe(5);
  });

  it("fails when a deliberate Swift fixture drifts behind TypeScript", () => {
    expect(() =>
      compareNativeStateSchemaVersions({
        swiftSource: "private static let maximumSupportedSchemaVersion: Int64 = 4\n",
        typescriptSource: "export const OPENCLAW_STATE_SCHEMA_VERSION = 5;\n",
      }),
    ).toThrow("Native state schema version drift: Swift supports 4, TypeScript owns 5");
  });
});
