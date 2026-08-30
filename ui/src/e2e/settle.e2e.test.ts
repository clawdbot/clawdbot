import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { waitForCommittedState } from "./settle.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI committed-state waits" });

suite.define(() => {
  it("retries async false results until commitment survives a render boundary", async () => {
    await suite.withPage({}, async ({ page }) => {
      await page.setContent('<body data-probes="0" data-committed="false"></body>');
      await waitForCommittedState(
        page,
        async () => {
          await Promise.resolve();
          const state = document.body.dataset;
          const probes = Number(state.probes) + 1;
          state.probes = String(probes);
          if (probes < 3) {
            return false;
          }
          state.committed = "true";
          requestAnimationFrame(() => {
            state.rendered = "true";
          });
          return true;
        },
        {},
      );

      expect(await page.locator("body").getAttribute("data-committed")).toBe("true");
      expect(await page.locator("body").getAttribute("data-rendered")).toBe("true");
    });
  });
});
