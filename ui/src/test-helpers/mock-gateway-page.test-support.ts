import { Script } from "node:vm";
import { JSDOM } from "jsdom";
import { it } from "vitest";

type MockGatewayPage = {
  window: Window & typeof globalThis;
  execute: (script: string) => void;
  close: () => void;
};

export const mockGatewayTest = it.extend<{ gatewayPage: MockGatewayPage }>({
  gatewayPage: async ({ task }, use) => {
    const dom = new JSDOM("", { url: "http://mock-control-ui/", runScripts: "outside-only" });
    try {
      await use({
        window: dom.window as unknown as Window & typeof globalThis,
        execute: (script) => {
          new Script(script, { filename: `mock-gateway:${task.name}` }).runInContext(
            dom.getInternalVMContext(),
          );
        },
        close: () => dom.window.close(),
      });
    } finally {
      // The serialized script owns page globals, listeners and queued work.
      // Close its realm even on assertion failure; never install it in Vitest's shared window.
      dom.window.close();
    }
  },
});
