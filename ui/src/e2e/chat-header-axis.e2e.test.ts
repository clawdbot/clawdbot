import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  chatSessionListResponse,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  for (const colorScheme of ["light", "dark"] as const) {
    it(`centers the project trail with the header actions in ${colorScheme} mode`, async () => {
      const context = await suite.newBrowserContext({
        colorScheme,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 520, width: 760 },
      });
      const page = await context.newPage();
      const favicon = await readFile(path.resolve(process.cwd(), "ui/public/favicon.svg"));
      await page.route("**/__openclaw__/workspace-icon/**", async (route) => {
        await route.fulfill({ body: favicon, contentType: "image/svg+xml", status: 200 });
      });
      await installMockGateway(page, {
        methodResponses: {
          "sessions.list": chatSessionListResponse([
            {
              key: "agent:main:session-a",
              kind: "direct",
              label: "Session A",
              spawnedCwd: "/repo/openclaw",
              updatedAt: 2,
            },
          ]),
        },
        sessionKey: "agent:main:session-a",
      });

      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        const header = page.locator(".chat-pane__header").first();
        await header.waitFor();
        await header.locator(".workspace-icon").waitFor();

        const centers = await header.evaluate((root) => {
          const centerY = (selector: string) => {
            const node = root.querySelector(selector);
            if (!node) {
              throw new Error(`missing header element: ${selector}`);
            }
            const rect = node.getBoundingClientRect();
            return rect.top + rect.height / 2;
          };
          return {
            nav: centerY(".chat-pane__nav-toggle svg"),
            projectIcon: centerY(".workspace-icon"),
            projectText: centerY(".chat-pane__workspace-chip span"),
            search: centerY(".chat-pane__palette-open svg"),
            separator: centerY(".chat-pane__crumb-sep"),
            sessionText: centerY(".chat-pane__session-title-text"),
          };
        });

        expect(Math.abs(centers.search - centers.nav), JSON.stringify(centers)).toBeLessThanOrEqual(
          0.1,
        );
        for (const center of [
          centers.projectIcon,
          centers.projectText,
          centers.separator,
          centers.sessionText,
        ]) {
          // Text and artwork carry more visible weight below their geometric
          // boxes than Lucide actions, so the identity trail needs a 1px
          // optical lift to share the topbar's perceived horizontal axis.
          expect(centers.nav - center, JSON.stringify(centers)).toBeCloseTo(1, 1);
        }
      } finally {
        await suite.closeBrowserContext(context);
      }
    });
  }
});
