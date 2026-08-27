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
    for (const viewport of [
      { label: "desktop", width: 800 },
      { label: "mobile", width: 760 },
    ] as const) {
      it(`lays out and navigates the ${viewport.label} project-parent-child trail in ${colorScheme} mode`, async () => {
        const context = await suite.newBrowserContext({
          colorScheme,
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 520, width: viewport.width },
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

          const geometry = await header.evaluate((root) => {
            const centerY = (selector: string) => {
              const node = root.querySelector(selector);
              if (!node) {
                throw new Error(`missing header element: ${selector}`);
              }
              const rect = node.getBoundingClientRect();
              return rect.top + rect.height / 2;
            };
            const rect = (selector: string) => {
              const node = root.querySelector(selector);
              if (!node) {
                throw new Error(`missing header element: ${selector}`);
              }
              return node.getBoundingClientRect().toJSON();
            };
            return {
              nav: centerY(".chat-pane__nav-toggle svg"),
              projectIcon: centerY(".workspace-icon"),
              projectText: centerY(".chat-pane__workspace-chip span"),
              menu: centerY(".chat-header-session-menu__trigger svg"),
              parentText: centerY(".chat-pane__parent-session-text"),
              sessionText: centerY(".chat-pane__session-title-text"),
              projectRow: rect(".chat-pane__project-row"),
              sessionTrail: rect(".chat-pane__session-trail"),
              separatorDisplays: [
                ...root.querySelectorAll<HTMLElement>(".chat-pane__crumb-sep"),
              ].map((node) => getComputedStyle(node).display),
            };
          });

          expect(
            Math.abs(geometry.menu - geometry.nav),
            JSON.stringify(geometry),
          ).toBeLessThanOrEqual(0.1);
          if (viewport.label === "desktop") {
            for (const center of [
              geometry.projectIcon,
              geometry.projectText,
              geometry.parentText,
              geometry.sessionText,
            ]) {
              // Text and artwork carry more visible weight below their geometric
              // boxes than Lucide actions, so the identity trail needs a 1px
              // optical lift to share the topbar's perceived horizontal axis.
              expect(geometry.nav - center, JSON.stringify(geometry)).toBeCloseTo(1, 1);
            }
            expect(geometry.separatorDisplays).toEqual(["block", "block"]);
          } else {
            expect(geometry.projectRow.bottom - geometry.sessionTrail.top).toBeLessThanOrEqual(0.1);
            expect(geometry.parentText).toBeCloseTo(geometry.sessionText, 1);
            expect(geometry.separatorDisplays).toEqual(["none", "none"]);
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
  }

  for (const viewport of [
    { height: 844, label: "portrait", width: 390 },
    { height: 393, label: "short landscape", width: 852 },
  ] as const) {
    it(`keeps compact ${viewport.label} transcript search below the floating header`, async () => {
      const context = await suite.newBrowserContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: viewport.height, width: viewport.width },
      });
      const page = await context.newPage();
      await installMockGateway(page, {
        methodResponses: { "sessions.list": chatSessionListResponse() },
      });

      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        await page.locator(".agent-chat__composer-combobox > textarea").focus();
        await page.keyboard.press("Control+f");
        const search = page.locator(".agent-chat__search-bar input");
        await search.waitFor();
        const [headerBox, searchBox] = await Promise.all([
          page.locator(".chat-pane__header").first().boundingBox(),
          search.boundingBox(),
        ]);
        expect(headerBox).not.toBeNull();
        expect(searchBox).not.toBeNull();
        expect(searchBox!.y).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height);
        await search.click();
        await search.fill("reachable");
        expect(await search.inputValue()).toBe("reachable");
      } finally {
        await suite.closeBrowserContext(context);
      }
    });

    it(`preserves compact ${viewport.label} New Session composer edge margins`, async () => {
      const context = await suite.newBrowserContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: viewport.height, width: viewport.width },
      });
      const page = await context.newPage();
      await installMockGateway(page, {
        methodResponses: { "sessions.list": chatSessionListResponse() },
      });

      try {
        await page.goto(`${suite.server.baseUrl}new`);
        await page.addStyleTag({ content: ":root { --safe-area-bottom: 34px !important; }" });
        const composer = page.locator(".new-session-page__composer");
        await composer.waitFor();
        const margins = await composer.evaluate((element) => {
          const style = getComputedStyle(element);
          return { bottom: style.marginBottom, left: style.marginLeft, right: style.marginRight };
        });
        expect(margins).toEqual({ bottom: "48px", left: "4px", right: "4px" });
      } finally {
        await suite.closeBrowserContext(context);
      }
    });
  }

  it("repaints a mounted project icon after the Gateway advertises a retry", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 520, width: 800 },
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
