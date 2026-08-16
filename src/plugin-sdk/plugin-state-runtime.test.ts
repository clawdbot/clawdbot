import { describe, expect, it, vi } from "vitest";
import { createPluginStateErrorReporter } from "./plugin-state-runtime.js";

describe("createPluginStateErrorReporter", () => {
  it("logs state failures with plugin bindings and default details", () => {
    const warn = vi.fn();
    const getChildLogger = vi.fn(() => ({ warn }));
    const report = createPluginStateErrorReporter(
      () => ({ logging: { getChildLogger } }) as never,
      "test-plugin",
      "state-cache",
      "persistent state failed",
    );

    report(new Error("boom"));

    expect(getChildLogger).toHaveBeenCalledWith({
      plugin: "test-plugin",
      feature: "state-cache",
    });
    expect(warn).toHaveBeenCalledWith("persistent state failed", { error: "Error: boom" });
  });

  it("swallows failures from runtime lookup and error formatting", () => {
    const runtimeFailure = createPluginStateErrorReporter(
      () => {
        throw new Error("runtime unavailable");
      },
      "test-plugin",
      "state-cache",
      "persistent state failed",
    );
    const formattingFailure = createPluginStateErrorReporter(
      () => ({ logging: { getChildLogger: () => ({ warn: vi.fn() }) } }) as never,
      "test-plugin",
      "state-cache",
      "persistent state failed",
      () => {
        throw new Error("formatting failed");
      },
    );

    expect(() => runtimeFailure(new Error("boom"))).not.toThrow();
    expect(() => formattingFailure(new Error("boom"))).not.toThrow();
  });
});
