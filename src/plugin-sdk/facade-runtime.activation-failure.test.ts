import { afterEach, expect, it, vi } from "vitest";
import {
  loadActivatedBundledPluginPublicSurfaceModule,
  resetFacadeRuntimeStateForTest,
} from "./facade-runtime.js";

afterEach(() => {
  vi.doUnmock("./facade-activation-check.runtime.js");
  resetFacadeRuntimeStateForTest();
});

it("preserves the unavailable activation error without loading a public artifact", async () => {
  resetFacadeRuntimeStateForTest();
  vi.doMock("./facade-activation-check.runtime.js", () => {
    throw new Error("activation dependency unavailable");
  });
  await expect(
    loadActivatedBundledPluginPublicSurfaceModule({
      dirName: "fixture",
      artifactBasename: "api.js",
    }),
  ).rejects.toThrow("Unable to load facade activation check runtime");
});
