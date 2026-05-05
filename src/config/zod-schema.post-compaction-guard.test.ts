import { describe, expect, it } from "vitest";
import { ToolsSchema } from "./zod-schema.agent-runtime.js";
import { OpenClawSchema } from "./zod-schema.js";

describe("OpenClawSchema tools.loopDetection.postCompactionGuard validation", () => {
  it("accepts tools.loopDetection.postCompactionGuard configuration", () => {
    const result = OpenClawSchema.safeParse({
      tools: {
        loopDetection: {
          enabled: true,
          postCompactionGuard: {
            windowSize: 5,
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty postCompactionGuard object", () => {
    const result = OpenClawSchema.safeParse({
      tools: {
        loopDetection: {
          postCompactionGuard: {},
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown keys under tools.loopDetection.postCompactionGuard", () => {
    const result = OpenClawSchema.safeParse({
      tools: {
        loopDetection: {
          postCompactionGuard: {
            windowSize: 3,
            bogus: "key",
          },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-positive windowSize", () => {
    const result = OpenClawSchema.safeParse({
      tools: {
        loopDetection: {
          postCompactionGuard: {
            windowSize: 0,
          },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer windowSize", () => {
    const result = OpenClawSchema.safeParse({
      tools: {
        loopDetection: {
          postCompactionGuard: {
            windowSize: 2.5,
          },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("validates via ToolsSchema directly", () => {
    const result = ToolsSchema.safeParse({
      loopDetection: {
        postCompactionGuard: { windowSize: 4 },
      },
    });
    expect(result.success).toBe(true);
  });
});
