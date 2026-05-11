import { describe, expect, it } from "vitest";
import { resolveConfigSetMode } from "./config-set-parser.js";

describe("resolveConfigSetMode", () => {
  it("selects value mode by default", () => {
    const result = resolveConfigSetMode({
      hasBatchMode: false,
      hasRefBuilderOptions: false,
      hasProviderBuilderOptions: false,
      strictJson: false,
    });
    expect(result).toEqual({ ok: true, mode: "value" });
  });

  it("selects json mode when strict parsing is enabled", () => {
    const result = resolveConfigSetMode({
      hasBatchMode: false,
      hasRefBuilderOptions: false,
      hasProviderBuilderOptions: false,
      strictJson: true,
    });
    expect(result).toEqual({ ok: true, mode: "json" });
  });

  it("selects ref-builder mode when ref flags are present", () => {
    const result = resolveConfigSetMode({
      hasBatchMode: false,
      hasRefBuilderOptions: true,
      hasProviderBuilderOptions: false,
      strictJson: false,
    });
    expect(result).toEqual({ ok: true, mode: "ref_builder" });
  });

  it("selects provider-builder mode when provider flags are present", () => {
    const result = resolveConfigSetMode({
      hasBatchMode: false,
      hasRefBuilderOptions: false,
      hasProviderBuilderOptions: true,
      strictJson: false,
    });
    expect(result).toEqual({ ok: true, mode: "provider_builder" });
  });

  it("returns batch mode when batch flags are present", () => {
    const result = resolveConfigSetMode({
      hasBatchMode: true,
      hasRefBuilderOptions: false,
      hasProviderBuilderOptions: false,
      strictJson: false,
    });
    expect(result).toEqual({ ok: true, mode: "batch" });
  });

  it("rejects ref-builder and provider-builder collisions", () => {
    const result = resolveConfigSetMode({
      hasBatchMode: false,
      hasRefBuilderOptions: true,
      hasProviderBuilderOptions: true,
      strictJson: false,
    });
    expect(result).toEqual({
      ok: false,
      error:
        "choose exactly one mode: ref builder (--ref-provider/--ref-source/--ref-id) or provider builder (--provider-*), not both.",
    });
  });

  it("rejects mixing batch mode with builder flags", () => {
    const result = resolveConfigSetMode({
      hasBatchMode: true,
      hasRefBuilderOptions: true,
      hasProviderBuilderOptions: false,
      strictJson: false,
    });
    expect(result).toEqual({
      ok: false,
      error:
        "batch mode (--batch-json/--batch-file) cannot be combined with ref builder (--ref-*) or provider builder (--provider-*) flags.",
    });
  });
});
