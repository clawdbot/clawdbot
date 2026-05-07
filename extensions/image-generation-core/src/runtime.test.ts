import { afterAll, describe, expect, it, vi } from "vitest";

const sdkExports = vi.hoisted(() => ({
  generateImage: vi.fn(),
  listRuntimeImageGenerationProviders: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/image-generation-runtime", () => sdkExports);

import {
  generateImage as sdkGenerateImage,
  listRuntimeImageGenerationProviders as sdkListRuntimeImageGenerationProviders,
} from "openclaw/plugin-sdk/image-generation-runtime";
import { generateImage, listRuntimeImageGenerationProviders } from "./runtime.js";

describe("image-generation-core runtime", () => {
  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/image-generation-runtime");
    vi.resetModules();
  });

  it("re-exports generateImage from the plugin sdk runtime", () => {
    expect(generateImage).toBe(sdkGenerateImage);
  });

  it("re-exports listRuntimeImageGenerationProviders from the plugin sdk runtime", () => {
    expect(listRuntimeImageGenerationProviders).toBe(sdkListRuntimeImageGenerationProviders);
  });
});
