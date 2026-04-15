import { beforeEach, describe, expect, it } from "vitest";
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
    const viaJiti = await loadThreadBindingsViaAlternateLoader();

    createThreadBindingManager({
      accountId: "work",
      persist: false,
      enableSweeper: false,
    });

    expect(getThreadBindingManager("work")).not.toBeNull();
    expect(viaJiti.getThreadBindingManager("work")).not.toBeNull();
  });
});
