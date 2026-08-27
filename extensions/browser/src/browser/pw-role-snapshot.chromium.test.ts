import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";
import { getPlaywrightCore } from "./playwright-core.runtime.js";
import { closePlaywrightBrowserConnection } from "./pw-session.js";
import { clickViaPlaywright, typeViaPlaywright } from "./pw-tools-core.interactions.actions.js";
import { snapshotAiViaPlaywright, snapshotRoleViaPlaywright } from "./pw-tools-core.snapshot.js";
import { getFreePort } from "./test-port.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.runIf(process.env.OPENCLAW_BROWSER_SNAPSHOT_E2E === "1")(
  "Chromium snapshot-to-action name fidelity",
  () => {
    it("resolves encoded duplicate names, textboxes, and frame-qualified AI refs", async () => {
      const rootDir = tempDirs.make("openclaw-snapshot-labels-");
      const port = await getFreePort();
      const cdpUrl = `http://127.0.0.1:${port}`;
      const context = await getPlaywrightCore().chromium.launchPersistentContext(
        path.join(rootDir, "profile"),
        {
          headless: true,
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
          args: [`--remote-debugging-port=${port}`],
        },
      );
      try {
        const page = context.pages()[0] ?? (await context.newPage());
        await page.setContent('<main></main><output></output><iframe title="Nested"></iframe>');
        const buttonName = 'Save: "owner\'s" C:\\draft 🦞';
        const inputName = 'Project "path"';
        await page.evaluate(
          ({ buttonName: label, inputName: inputLabel }) => {
            for (const id of ["first", "second"]) {
              const button = document.createElement("button");
              button.textContent = label;
              button.addEventListener("click", () => {
                document.querySelector("output")!.textContent = id;
              });
              document.querySelector("main")!.append(button);
            }
            const input = document.createElement("input");
            input.setAttribute("aria-label", inputLabel);
            document.querySelector("main")!.append(input);
            document.querySelector("iframe")!.srcdoc =
              "<button onclick=\"this.textContent='Frame clicked'\">Frame: action</button>";
          },
          { buttonName, inputName },
        );
        await page.frameLocator("iframe").getByRole("button").waitFor();
        const session = await context.newCDPSession(page);
        const { targetInfo } = await session.send("Target.getTargetInfo");
        await session.detach();
        const target = { cdpUrl, targetId: targetInfo.targetId };
        for (const mode of ["role", "interactive", "ai", "interactive-aria"] as const) {
          const snapshot =
            mode === "ai"
              ? await snapshotAiViaPlaywright(target)
              : await snapshotRoleViaPlaywright({
                  ...target,
                  refsMode: mode === "interactive-aria" ? "aria" : "role",
                  options: { interactive: mode !== "role" },
                });
          const buttons = Object.entries(snapshot.refs).filter(
            ([, value]) => value.role === "button" && value.name === buttonName,
          );
          expect(buttons, mode).toHaveLength(2);
          for (const [index, [ref]] of buttons.entries()) {
            await clickViaPlaywright({ ...target, ref, timeoutMs: 1_000 });
            expect(await page.locator("output").textContent(), mode).toBe(
              index ? "second" : "first",
            );
          }
          const input = Object.entries(snapshot.refs).find(
            ([, value]) => value.role === "textbox" && value.name === inputName,
          );
          expect(input, mode).toBeDefined();
          await typeViaPlaywright({ ...target, ref: input![0], text: mode, timeoutMs: 1_000 });
          expect(await page.getByRole("textbox").inputValue()).toBe(mode);
        }
        const snapshot = await snapshotAiViaPlaywright(target);
        const nested = Object.entries(snapshot.refs).find(
          ([, value]) => value.name === "Frame: action",
        );
        expect(nested).toBeDefined();
        await clickViaPlaywright({ ...target, ref: nested![0], timeoutMs: 1_000 });
        expect(await page.frameLocator("iframe").getByRole("button").textContent()).toBe(
          "Frame clicked",
        );
      } finally {
        await closePlaywrightBrowserConnection({ cdpUrl });
        await context.close();
      }
    }, 30_000);
  },
);
