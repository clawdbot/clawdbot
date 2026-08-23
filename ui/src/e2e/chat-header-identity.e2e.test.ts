import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { controlUiBundledSettingsStorageKey } from "../test-helpers/control-ui-e2e.ts";
import {
  captureUiProofEnabled,
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "chat-header-identity");

const LONG_TITLE =
  "Rework the release readiness checklist and reconcile the production rollout plan";

/**
 * Session list that puts every header identity state on screen at once: two
 * distinct owners (which is what turns on owner attribution), a project
 * with a resolvable icon, and a long title for the truncation case.
 */
function identitySessions() {
  const owners = [
    { id: "profile-ada", label: "Ada Lovelace", type: "human" as const },
    { id: "profile-grace", label: "Grace Hopper", type: "human" as const },
  ];
  return {
    ...chatSessionListResponse([
      {
        createdActor: owners[0],
        key: "agent:main:session-a",
        kind: "direct",
        label: "Header identity trail",
        owner: { actor: owners[0] },
        spawnedCwd: "/repo/openclaw",
        updatedAt: 2,
      },
      {
        createdActor: owners[1],
        key: "agent:main:session-b",
        kind: "direct",
        label: LONG_TITLE,
        owner: { actor: owners[1] },
        spawnedCwd: "/repo/openclaw",
        updatedAt: 1,
      },
    ]),
    owners,
  };
}

suite.define(() => {
  for (const theme of ["light", "dark"] as const) {
    it(`groups project, session, owner, and viewers in the ${theme} chat header`, async () => {
      const context = await suite.newBrowserContext({
        colorScheme: theme,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 560, width: 1120 },
      });
      const page = await context.newPage();
      const capture = async (name: string) => {
        if (!captureUiProofEnabled) {
          return;
        }
        await mkdir(proofDir, { recursive: true });
        await page
          .locator(".chat-pane__header")
          .first()
          .screenshot({
            animations: "disabled",
            path: path.join(proofDir, `${name}-${theme}.png`),
          });
      };
      // Persisted settings, not just the media query: themeMode only follows the
      // OS preference while it is "system", so seeding both pins the frame.
      await page.addInitScript(
        ({ key, mode }) => {
          localStorage.setItem(key, JSON.stringify({ theme: "claw", themeMode: mode }));
        },
        { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl), mode: theme },
      );
      const favicon = await readFile(path.resolve(process.cwd(), "ui/public/favicon.svg"));
      await page.route("**/__openclaw__/workspace-icon/**", async (route) => {
        await route.fulfill({ body: favicon, contentType: "image/svg+xml", status: 200 });
      });
      await installMockGateway(page, {
        methodResponses: { "sessions.list": identitySessions() },
        presenceUsers: [
          { id: "profile-ada", name: "Ada Lovelace", self: true, watchedSessions: [] },
          {
            id: "profile-grace",
            name: "Grace Hopper",
            watchedSessions: ["agent:main:session-a"],
          },
          { id: "profile-alan", name: "Alan Turing", watchedSessions: ["agent:main:session-a"] },
        ],
        sessionKey: "agent:main:session-a",
      });

      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        const header = page.locator(".chat-pane__header").first();
        await header.waitFor();
        await header.locator(".workspace-icon").waitFor();
        await header.locator(".chat-pane__session-menu-anchor").waitFor();
        await capture("rest");

        const trail = await header.evaluate((root) => {
          const box = (selector: string) => {
            const node = root.querySelector(selector);
            if (!node) {
              throw new Error(`missing header element: ${selector}`);
            }
            return node.getBoundingClientRect();
          };
          const owner = box(".chat-pane__session-controls .session-owner-chip");
          const ownerStyle = getComputedStyle(
            root.querySelector(".chat-pane__session-controls .session-owner-chip")!,
          );
          const centerY = (selector: string) => {
            const rect = box(selector);
            return rect.top + rect.height / 2;
          };
          return {
            owner: { height: owner.height, width: owner.width },
            ownerLeft: owner.left,
            ownerShadow: ownerStyle.boxShadow,
            menuGlyphCenter: centerY(".chat-pane__session-menu-anchor svg"),
            menuLeft: box(".chat-pane__session-menu-anchor").left,
            menuRight: box(".chat-pane__session-menu-anchor").right,
            headerCenter: (() => {
              const rect = root.getBoundingClientRect();
              return rect.top + rect.height / 2;
            })(),
            projectRight: box(".chat-pane__workspace-chip .workspace-icon").right,
            titleLeft: box(".chat-pane__session-title").left,
            titleTextLeft: box(".chat-pane__session-title-text").left,
            titleRight: box(".chat-pane__session-title").right,
            viewerHeight: box(".chat-pane__presence .viewer-avatar").height,
            // The facepile host renders through display:contents, so the first
            // avatar is what actually has a position in the row.
            viewerLeft: box(".chat-pane__presence .viewer-avatar").left,
          };
        });

        // Reading order is the ownership story: project, then session and its
        // menu, then the owner and everyone else watching.
        expect(trail.projectRight).toBeLessThan(trail.titleLeft);
        expect(trail.titleRight).toBeLessThanOrEqual(trail.menuLeft + 1);
        expect(trail.menuRight).toBeLessThanOrEqual(trail.ownerLeft);
        expect(trail.ownerLeft).toBeLessThan(trail.viewerLeft);
        // One avatar scale across the trail, and no decoration on it.
        expect(trail.owner.height).toBeCloseTo(26, 4);
        expect(trail.owner.width).toBeCloseTo(26, 4);
        expect(trail.viewerHeight).toBeCloseTo(26, 4);
        expect(trail.ownerShadow).toBe("none");
        // The menu's explicit 1px optical adjustment stays stable against the
        // geometric centerline instead of inheriting text-baseline movement.
        expect(
          Math.abs(trail.menuGlyphCenter - trail.headerCenter),
          JSON.stringify(trail),
        ).toBeCloseTo(1, 4);

        // Renaming edits in place: same row height, same text origin.
        await header.locator(".chat-pane__session-title-button").click();
        const input = header.locator(".chat-pane__session-title-input");
        await input.waitFor();
        await capture("rename");
        const rename = await header.evaluate((root) => {
          const field = root.querySelector(".chat-pane__session-title-input")!;
          const style = getComputedStyle(field);
          return {
            headerHeight: root.getBoundingClientRect().height,
            // Where the typed text actually starts: the field's own box, plus the
            // border and padding drawn inside it.
            textLeft:
              field.getBoundingClientRect().left +
              Number.parseFloat(style.borderLeftWidth) +
              Number.parseFloat(style.paddingLeft),
          };
        });
        expect(rename.headerHeight).toBe(48);
        expect(
          Math.abs(rename.textLeft - trail.titleTextLeft),
          JSON.stringify({ rename, titleTextLeft: trail.titleTextLeft }),
        ).toBeLessThanOrEqual(1);
        await page.keyboard.press("Escape");

        // On a narrow pane a long name truncates, but it never pushes the
        // session's own controls out of the header.
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:session-b"));
        await expect
          .poll(() => header.locator(".chat-pane__session-title-text").textContent())
          .toBe(LONG_TITLE);
        await page.setViewportSize({ height: 560, width: 640 });
        await expect
          .poll(async () =>
            header.locator(".chat-pane__session-title-text").evaluate((text) => {
              const node = text as HTMLElement;
              return node.scrollWidth > node.clientWidth;
            }),
          )
          .toBe(true);
        await capture("long-title-narrow");
        const overflow = await header.evaluate((root) => ({
          headerRight: root.getBoundingClientRect().right,
          menuRight: root.querySelector(".chat-pane__session-menu-anchor")!.getBoundingClientRect()
            .right,
        }));
        expect(overflow.menuRight).toBeLessThanOrEqual(overflow.headerRight);
      } finally {
        await suite.closeBrowserContext(context);
      }
    });
  }
});
