import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

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

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("Control UI terminal runtime isolation", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed or cannot start at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("does not reuse freed terminal cells in the next tab", async () => {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    const moduleUrl = new URL("src/components/terminal/terminal-runtime.ts", server.baseUrl).href;

    try {
      await page.goto(server.baseUrl);
      await page.addScriptTag({
        content: `globalThis.openclawTerminalRuntimeModule = import(${JSON.stringify(moduleUrl)});`,
        type: "module",
      });
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
    } finally {
      await context.close();
    }
  });
});
