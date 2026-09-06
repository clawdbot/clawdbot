import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Mermaid asset load errors" });
const source = `flowchart LR
  A[Idea] --> B{Worth pursuing?}
  B -- No --> C[Park it]
  B -- Yes --> D[Small experiment]
  D --> E{Evidence of value?}
  E -- No --> F[Learn & adjust]
  F --> D
  E -- Yes --> G[Build a repeatable system]
  G --> H[More time for creative work]`;

suite.define(() => {
  it.each(["frame", "markdown-mermaid"])(
    "reports a blocked %s script as a renderer failure and recovers after reload",
    async (asset) => {
      await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
        const blockedScript = new RegExp(`/${asset}-[^/]+\\.js(?:\\?.*)?$`, "u");
        let blocked = 0;
        await page.route(blockedScript, (route) => {
          blocked += 1;
          return route.abort();
        });
        const gateway = await installMockGateway(page, {
          historyMessages: [
            {
              role: "assistant",
              content: [{ type: "text", text: `\`\`\`mermaid\n${source}\n\`\`\`` }],
            },
          ],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("chat.startup");
        const failure = page.getByText(/check proxy or authentication rules/u);
        await failure.waitFor({ timeout: 25_000 });
        expect(blocked).toBeGreaterThan(0);
        expect(await page.getByText("Check the source or simplify", { exact: false }).count()).toBe(
          0,
        );
        expect(await page.locator("pre code").last().textContent()).toContain(source);

        await page.unroute(blockedScript);
        await page.reload();
        const image = page.locator("openclaw-mermaid img");
        await image.waitFor({ timeout: 25_000 });
        await image.evaluate((element: HTMLImageElement) => element.decode());
        expect(await failure.count()).toBe(0);
      });
    },
  );
});
