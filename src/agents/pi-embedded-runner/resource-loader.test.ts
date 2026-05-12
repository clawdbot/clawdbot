import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  createEmbeddedPiResourceLoader,
  EMBEDDED_PI_RESOURCE_LOADER_DISCOVERY_OPTIONS,
} from "./resource-loader.js";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  DefaultResourceLoader: vi.fn(function DefaultResourceLoader(
    this: Record<string, unknown>,
    options: unknown,
  ) {
    Object.assign(this, {
      options,
      reload: vi.fn(async () => undefined),
    });
  }),
}));

describe("createEmbeddedPiResourceLoader", () => {
  it("keeps inline extensions but disables Pi filesystem discovery", () => {
    const settingsManager = {};
    const extensionFactories = [vi.fn()];

    createEmbeddedPiResourceLoader({
      cwd: "/workspace",
      agentDir: "/agent",
      settingsManager: settingsManager as never,
      extensionFactories: extensionFactories as never,
    });

    expect(DefaultResourceLoader).toHaveBeenCalledWith({
      cwd: "/workspace",
      agentDir: "/agent",
      settingsManager,
      extensionFactories,
      ...EMBEDDED_PI_RESOURCE_LOADER_DISCOVERY_OPTIONS,
    });
  });
});
