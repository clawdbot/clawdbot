import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";
import { getPlaywrightCore } from "./playwright-core.runtime.js";
import {
  closePlaywrightBrowserConnection,
  refLocator,
  restoreRoleRefsForTarget,
} from "./pw-session.js";
import { BROWSER_REF_MARKER_ATTRIBUTE } from "./pw-session.page-cdp.js";
import { clickViaPlaywright, typeViaPlaywright } from "./pw-tools-core.interactions.actions.js";
import {
  snapshotAiViaPlaywright,
  snapshotAriaViaPlaywright,
  snapshotRoleViaPlaywright,
  storeAriaSnapshotRefsViaPlaywright,
} from "./pw-tools-core.snapshot.js";
import { getFreePort } from "./test-port.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.runIf(process.env.OPENCLAW_BROWSER_SNAPSHOT_E2E === "1")(
  "Chromium snapshot-to-action name fidelity",
  () => {
    it("returns selector no-match snapshots without waiting for the snapshot timeout", async () => {
      const rootDir = tempDirs.make("openclaw-snapshot-selector-absence-");
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
        await page.setContent('<main><button id="present">Present</button></main>');
        const session = await context.newCDPSession(page);
        const { targetInfo } = await session.send("Target.getTargetInfo");
        await session.detach();
        const target = { cdpUrl, targetId: targetInfo.targetId };

        const startedAt = performance.now();
        const missing = await snapshotRoleViaPlaywright({
          ...target,
          selector: "#missing",
          timeoutMs: 30_000,
        });
        const elapsedMs = performance.now() - startedAt;
        const present = await snapshotRoleViaPlaywright({
          ...target,
          selector: "#present",
          timeoutMs: 30_000,
        });

        expect(missing.snapshot).toBe("(empty)");
        expect(missing.refs).toEqual({});
        expect(elapsedMs).toBeLessThan(1_000);
        expect(present.snapshot).toContain('button "Present"');
      } finally {
        await closePlaywrightBrowserConnection({ cdpUrl });
        await context.close();
      }
    }, 30_000);

    it("resolves encoded and omitted names, raw AX names, and native frame refs", async () => {
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
        await page.setContent(
          '<style>button{min-width:30px;min-height:25px}</style><main></main><output></output><iframe title="Nested"></iframe>',
        );
        const buttonName = 'Save: "owner\'s" C:\\draft 🦞';
        const inputName = 'Project "path"';
        const nameControls = [
          { id: "short", name: "Named control" },
          { id: "empty", name: "" },
          { id: "empty-again", name: "" },
          { id: "name-900", name: "x".repeat(900) },
          { id: "name-901", name: "x".repeat(901) },
          { id: "surrogates-900", name: "😀".repeat(450) },
          { id: "surrogates-901", name: "😀".repeat(450) + "x" },
          { id: "normalized-empty", name: "\u200b\u00ad" },
          { id: "normalized-899", name: "  x \n".repeat(450) },
          { id: "normalized-901", name: "  x \n".repeat(451) },
        ];
        await page.evaluate(
          ({ buttonName: label, inputName: inputLabel, nameControls: controls }) => {
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
            const slash = document.createElement("button");
            slash.textContent = "/";
            slash.addEventListener("click", () => {
              document.querySelector("output")!.textContent = "/";
            });
            document.querySelector("main")!.append(slash);
            for (const { id, name } of controls) {
              const button = document.createElement("button");
              button.setAttribute("aria-label", name);
              button.textContent = name ? "control" : "";
              button.addEventListener("click", () => {
                document.querySelector("output")!.textContent = id;
              });
              document.querySelector("main")!.append(button);
            }
            document.querySelector("iframe")!.srcdoc =
              "<button onclick=\"this.textContent='Frame clicked'\">Frame: action</button>";
          },
          { buttonName, inputName, nameControls },
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
            ([, value]) => value.role === "button" && value.name !== "Frame: action",
          );
          const expectedButtons = ["first", "second", "/", ...nameControls.map(({ id }) => id)];
          expect(buttons, mode).toHaveLength(expectedButtons.length);
          for (const [index, [ref]] of buttons.entries()) {
            await clickViaPlaywright({ ...target, ref, timeoutMs: 1_000 });
            expect(await page.locator("output").textContent(), mode).toBe(expectedButtons[index]);
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

        await page.setContent(
          "<style>button{min-width:30px;min-height:25px}</style><main></main><output></output>",
        );
        const rawControls = [
          { id: "raw-short", name: "Raw named control" },
          { id: "raw-empty", name: "" },
          { id: "raw-long", name: "x".repeat(901) },
          { id: "raw-short-again", name: "Raw named control" },
        ];
        await page.evaluate((controls) => {
          for (const { id, name } of controls) {
            const button = document.createElement("button");
            button.setAttribute("aria-label", name);
            button.textContent = name ? "control" : "";
            button.addEventListener("click", () => {
              document.querySelector("output")!.textContent = id;
            });
            document.querySelector("main")!.append(button);
          }
        }, rawControls);
        const aria = await snapshotAriaViaPlaywright(target);
        const rawButtons = aria.nodes.filter((node) => node.role.toLowerCase() === "button");
        expect(rawButtons).toHaveLength(rawControls.length);
        expect(
          await page
            .getByRole("button", { name: "", exact: true })
            .getAttribute(BROWSER_REF_MARKER_ATTRIBUTE),
        ).toBe(rawButtons[1]!.ref);
        await clickViaPlaywright({ ...target, ref: rawButtons[1]!.ref, timeoutMs: 1_000 });
        expect(await page.locator("output").textContent()).toBe("raw-empty");
        // Real AX names with unavailable DOM ids exercise the existing role fallback.
        // Restore onto the launcher's distinct Page wrapper to cross the target cache.
        await storeAriaSnapshotRefsViaPlaywright({
          ...target,
          nodes: aria.nodes.map(({ backendDOMNodeId: _backendId, ...node }) => node),
        });
        expect(await page.locator(`[${BROWSER_REF_MARKER_ATTRIBUTE}]`).count()).toBe(0);
        restoreRoleRefsForTarget({ ...target, page });
        for (const [index, node] of rawButtons.entries()) {
          await refLocator(page, node.ref).click({ timeout: 1_000 });
          expect(await page.locator("output").textContent()).toBe(rawControls[index]!.id);
        }
      } finally {
        await closePlaywrightBrowserConnection({ cdpUrl });
        await context.close();
      }
    }, 30_000);
  },
);
