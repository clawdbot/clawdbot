import { expect, it } from "vitest";
import { startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI terminal runtime isolation",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

type BrowserTerminalController = {
  terminal: {
    wasmTerm?: {
      getLine: (row: number) => Array<{ codepoint: number }> | null;
    };
  };
  dispose: () => void;
  write: (bytes: Uint8Array) => void;
};

type BrowserTerminalFactory = (options: {
  autoFit: boolean;
  parent: HTMLElement;
  readOnly: boolean;
  size: { columns: number; rows: number };
}) => Promise<BrowserTerminalController>;

suite.define(() => {
  it("does not reuse freed terminal cells in the next tab", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const moduleUrl = new URL("src/components/terminal/terminal-runtime.ts", suite.server.baseUrl)
        .href;

      await page.goto(suite.server.baseUrl);
      // addScriptTag resolves before the module body runs, so the global is not
      // observable yet; wait for the assignment instead of racing page.evaluate.
      await page.addScriptTag({
        content: `globalThis.openclawTerminalRuntimeModule = import(${JSON.stringify(moduleUrl)});`,
        type: "module",
      });
      await page.waitForFunction(() =>
        Boolean(
          (globalThis as unknown as { openclawTerminalRuntimeModule?: unknown })
            .openclawTerminalRuntimeModule,
        ),
      );
      const sentinel = "CLOSE_RESET_SENTINEL";
      const result = await page.evaluate(
        async ({ staleText }) => {
          const runtimeModule = await (
            window as unknown as Window & {
              openclawTerminalRuntimeModule: Promise<{
                createIsolatedGhosttyTerminal: BrowserTerminalFactory;
              }>;
            }
          ).openclawTerminalRuntimeModule;
          const createTerminal = async () => {
            const host = document.createElement("div");
            host.style.height = "400px";
            host.style.width = "800px";
            document.body.append(host);
            const controller = await runtimeModule.createIsolatedGhosttyTerminal({
              autoFit: false,
              parent: host,
              readOnly: true,
              size: { columns: 80, rows: 24 },
            });
            return { controller, host };
          };
          const lineText = (controller: BrowserTerminalController) =>
            (controller.terminal.wasmTerm?.getLine(0) ?? [])
              .map((cell) =>
                cell.codepoint > 0 && cell.codepoint <= 0x10ffff
                  ? String.fromCodePoint(cell.codepoint)
                  : " ",
              )
              .join("");

          const first = await createTerminal();
          first.controller.write(new TextEncoder().encode(`${staleText} 👋🏽`));
          const firstLine = lineText(first.controller);
          first.controller.dispose();
          first.host.remove();

          const second = await createTerminal();
          const initialSecondLine = lineText(second.controller);
          second.controller.write(new TextEncoder().encode("FRESH"));
          const finalSecondLine = lineText(second.controller);
          second.controller.dispose();
          second.host.remove();
          return { finalSecondLine, firstLine, initialSecondLine };
        },
        { staleText: sentinel },
      );

      expect(result.firstLine).toContain(sentinel);
      expect(result.initialSecondLine).not.toContain(sentinel);
      expect(result.initialSecondLine.trim()).toBe("");
      expect(result.finalSecondLine).toContain("FRESH");
    });
  });
});
