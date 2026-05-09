import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("OpenClawSchema logging levels", () => {
  it("accepts valid logging level values for level and consoleLevel", () => {
    expect(
      OpenClawSchema.safeParse({
        logging: {
          level: "debug",
          consoleLevel: "warn",
        },
      }),
    ).toMatchObject({ success: true });
  });

  it("rejects invalid logging level values", () => {
    const invalidLevel = OpenClawSchema.safeParse({
      logging: {
        level: "loud",
      },
    });
    const invalidConsoleLevel = OpenClawSchema.safeParse({
      logging: {
        consoleLevel: "verbose",
      },
    });

    expect(invalidLevel).toMatchObject({ success: false });
    if (!invalidLevel.success) {
      expect(invalidLevel.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["logging", "level"],
        }),
      );
    }
    expect(invalidConsoleLevel).toMatchObject({ success: false });
    if (!invalidConsoleLevel.success) {
      expect(invalidConsoleLevel.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["logging", "consoleLevel"],
        }),
      );
    }
  });
});
