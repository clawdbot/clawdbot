import { describe, expect, it, vi } from "vitest";

vi.mock("../process/exec.js", () => {
  throw new Error("light CLI credential helpers loaded the process runner");
});

describe("light CLI credential imports", () => {
  it("keeps model auth reads off the child-process runtime", async () => {
    const module = await import("./cli-credentials.js");

    expect(module.readMiniMaxCliCredentialsCached).toBeTypeOf("function");
    expect(module.readGeminiCliCredentialsCached).toBeTypeOf("function");
  });
});
