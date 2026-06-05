// Verifies outbound tool-payload extraction remains the plugin-sdk facade.
import { describe, expect, it } from "vitest";
import { extractToolPayload as extractSharedToolPayload } from "../../plugin-sdk/tool-payload.js";
import { extractToolPayload } from "./tool-payload.js";

describe("extractToolPayload", () => {
  it("re-exports the shared plugin-sdk helper", () => {
    expect(extractToolPayload).toBe(extractSharedToolPayload);
  });
});
