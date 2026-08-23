import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  chatSessionListResponse,
  captureUiProofEnabled,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  for (const colorScheme of ["light", "dark"] as const) {
    it(`centers and navigates the project-parent-child trail in ${colorScheme} mode`, async () => {
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
              key: "agent:main:parent",
              kind: "direct",
              label: "Release readiness and production rollout coordination",
              spawnedCwd: "/repo/openclaw",
              updatedAt: 1,
            },
            {
              key: "agent:main:session-a",
              kind: "direct",
              label: "Implement parent breadcrumb navigation and polish overflow behavior",
              parentSessionKey: "agent:main:parent",
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
            menu: centerY(".chat-header-session-menu__trigger svg"),
            separator: centerY(".chat-pane__crumb-sep"),
            parentText: centerY(".chat-pane__parent-session-text"),
            sessionText: centerY(".chat-pane__session-title-text"),
          };
        });

        expect(Math.abs(centers.menu - centers.nav), JSON.stringify(centers)).toBeLessThanOrEqual(
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
        expect(await header.locator(".chat-pane__crumb-sep").count()).toBe(2);
        const parent = header.locator(".chat-pane__parent-session");
        const nestedTrail = await header.evaluate((root) => {
          const parentCrumb = root.querySelector<HTMLElement>(".chat-pane__parent-session")!;
          const child = root.querySelector<HTMLElement>(".chat-pane__session-title")!;
          const parentText = root.querySelector<HTMLElement>(".chat-pane__parent-session-text")!;
          const childText = root.querySelector<HTMLElement>(".chat-pane__session-title-text")!;
          const headerRect = root.getBoundingClientRect();
          return {
            childEllipses: childText.scrollWidth > childText.clientWidth,
            headerWidth: headerRect.width,
            parentEllipses: parentText.scrollWidth > parentText.clientWidth,
            width: child.getBoundingClientRect().right - parentCrumb.getBoundingClientRect().left,
          };
        });
        expect(nestedTrail.parentEllipses).toBe(true);
        expect(nestedTrail.childEllipses).toBe(true);
        expect(nestedTrail.width).toBeLessThanOrEqual(nestedTrail.headerWidth / 2 + 1);
        expect((await parent.textContent())?.trim()).toBe(
          "Release readiness and production rollout coordination",
        );
        await parent.click();
        await expect
          .poll(() => header.locator(".chat-pane__session-title-text").textContent())
          .toBe("Release readiness and production rollout coordination");
      } finally {
        await suite.closeBrowserContext(context);
      }
    });
  }

  it("repaints a mounted project icon after the Gateway advertises a retry", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 520, width: 760 },
    });
    const page = await context.newPage();
    const favicon = await readFile(path.resolve(process.cwd(), "ui/public/favicon.svg"));
    let requests = 0;
    await page.route("**/__openclaw__/workspace-icon/**", async (route) => {
      requests += 1;
      if (requests === 1) {
        await route.fulfill({
          body: "workspace icon snapshot is not ready",
          headers: { "retry-after": "1" },
          status: 503,
        });
        return;
      }
      await route.fulfill({ body: favicon, contentType: "image/svg+xml", status: 200 });
    });
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": chatSessionListResponse([
          {
            key: "agent:main:session-a",
            kind: "direct",
            label: "Workspace icon recovery",
            spawnedCwd: "/repo/openclaw",
            updatedAt: 1,
          },
        ]),
      },
      sessionKey: "agent:main:session-a",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const icon = page.locator(".chat-pane__header openclaw-workspace-icon").first();
      await icon.waitFor();
      await icon.locator("svg").waitFor();
      await icon.evaluate((element) => element.setAttribute("data-recovery-host", "mounted"));
      const proofDir = path.join(
        process.cwd(),
        ".artifacts",
        "control-ui-e2e",
        "workspace-icon-recovery",
      );
      if (captureUiProofEnabled) {
        await mkdir(proofDir, { recursive: true });
        await page.screenshot({ path: path.join(proofDir, "fallback.png") });
      }

      await icon.locator(".workspace-icon").waitFor({ timeout: 10_000 });

      expect(requests).toBe(2);
      expect(await icon.getAttribute("data-recovery-host")).toBe("mounted");
      if (captureUiProofEnabled) {
        await page.screenshot({ path: path.join(proofDir, "recovered.png") });
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
