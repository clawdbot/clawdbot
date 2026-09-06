import { describe, expect, it } from "vitest";
import { WINDOWS_JOB_ANCHOR_CREATE_PROCESS_FLAGS } from "./service-child-windows-job-native.js";

describe("Windows Job anchor CreateProcessW flags", () => {
  it("includes CREATE_NO_WINDOW so the anchored child console stays hidden", () => {
    const CREATE_NO_WINDOW = 0x0800_0000;
    expect(WINDOWS_JOB_ANCHOR_CREATE_PROCESS_FLAGS & CREATE_NO_WINDOW).toBe(CREATE_NO_WINDOW);
  });
});
