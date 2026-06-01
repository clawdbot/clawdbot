import { describe, expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../sessions/index.js";
import {
  createEmbeddedAgentResourceLoader,
  EMBEDDED_AGENT_RESOURCE_LOADER_DISCOVERY_OPTIONS,
} from "./resource-loader.js";

vi.mock("../sessions/index.js", () => ({
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
      ...EMBEDDED_AGENT_RESOURCE_LOADER_DISCOVERY_OPTIONS,
    });
  });
});
