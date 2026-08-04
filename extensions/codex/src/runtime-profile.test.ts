import { describe, expect, it } from "vitest";
import { isCodexFullRuntime, resolveCodexRuntimeProfile } from "./runtime-profile.js";

describe("Codex runtime profile", () => {
  it("defaults to lean", () => {
    expect(resolveCodexRuntimeProfile({})).toBe("lean");
    expect(isCodexFullRuntime({})).toBe(false);
  });

  it("enables advanced surfaces only for full", () => {
    expect(resolveCodexRuntimeProfile({ runtimeProfile: "full" })).toBe("full");
    expect(isCodexFullRuntime({ runtimeProfile: "full" })).toBe(true);
  });

  it("preserves advanced behavior for existing configured surfaces", () => {
    expect(resolveCodexRuntimeProfile({ supervision: { enabled: false } })).toBe("full");
    expect(resolveCodexRuntimeProfile({ sessionCatalog: { enabled: false } })).toBe("full");
  });
});
