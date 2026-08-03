// Coverage for embedded resource loader discovery restrictions.
import { describe, expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../sessions/index.js";
import { createEmbeddedAgentResourceLoader } from "./resource-loader.js";

vi.mock("../sessions/index.js", () => ({
  // Constructor mock captures options so tests can assert discovery policy
  // without touching filesystem-backed session resources.
  DefaultResourceLoader: vi.fn(function DefaultResourceLoaderLocal(
    this: Record<string, unknown>,
    options: unknown,
  ) {
    Object.assign(this, {
      options,
      reload: vi.fn(async () => undefined),
    });
  }),
}));

describe("createEmbeddedAgentResourceLoader", () => {
  it("keeps inline extensions but disables filesystem discovery", () => {
    // Embedded runs pass explicit extension factories; filesystem discovery is
    // disabled to avoid loading ambient workspace extensions.
    const settingsManager = {};
    const extensionFactories = [vi.fn()];

    createEmbeddedAgentResourceLoader({
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
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
  });
});
