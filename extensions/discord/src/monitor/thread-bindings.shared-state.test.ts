import { beforeEach, describe, expect, it } from "vitest";
import { EMPTY_DISCORD_TEST_CONFIG } from "../test-support/config.js";
import {
  __testing as threadBindingsTesting,
  createThreadBindingManager,
  getThreadBindingManager,
} from "./thread-bindings.js";

type ThreadBindingsModule = {
  getThreadBindingManager: typeof getThreadBindingManager;
};

async function loadThreadBindingsViaAlternateLoader(): Promise<ThreadBindingsModule> {
  const fallbackPath = "./thread-bindings.ts?vitest-loader-fallback";
  return (await import(/* @vite-ignore */ fallbackPath)) as ThreadBindingsModule;
}

describe("thread binding manager state", () => {
  beforeEach(() => {
    threadBindingsTesting.resetThreadBindingsForTests();
  });

  it("shares managers between ESM and alternate-loaded module instances", async () => {
    const viaAlternateLoader = await loadThreadBindingsViaAlternateLoader();

    createThreadBindingManager({
      cfg: EMPTY_DISCORD_TEST_CONFIG,
      accountId: "work",
      persist: false,
      enableSweeper: false,
    });

    const direct = getThreadBindingManager("work");
    expect(direct).toBeDefined();
    expect(viaAlternateLoader.getThreadBindingManager("work")).toBe(direct);
  });
});
