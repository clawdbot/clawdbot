import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  browserLaunchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] },
  name: "Control UI composer capability menu height",
});

function skill(index: number) {
  const name = `Skill ${String(index).padStart(2, "0")}`;
  return {
    name,
    description: `${name} skill`,
    source: "test",
    filePath: `/tmp/openclaw-e2e/skills/${name}/SKILL.md`,
    baseDir: `/tmp/openclaw-e2e/skills/${name}`,
    skillKey: name.toLowerCase().replaceAll(" ", "-"),
    always: false,
    disabled: false,
    blockedByAllowlist: false,
    eligible: true,
    requirements: { anyBins: [], bins: [], env: [], config: [], os: [] },
    missing: { anyBins: [], bins: [], env: [], config: [], os: [] },
    configChecks: [],
    install: [],
  };
}

function sessionsList() {
  return {
    count: 1,
    defaults: { contextTokens: 200_000, model: "gpt-5.5", modelProvider: "openai" },
    path: "",
    sessions: [
      {
        key: "main",
        kind: "direct",
        model: "gpt-5.5",
        modelProvider: "openai",
        status: "done",
        updatedAt: Date.now(),
      },
    ],
    ts: Date.now(),
  };
}

function configResponse() {
  const servers = Object.fromEntries(
    Array.from({ length: 24 }, (_, index) => [
      `connector-${String(index).padStart(2, "0")}`,
      { enabled: true, url: `https://connector-${index}.example.test` },
    ]),
  );
  const config = { mcp: { servers }, tools: { web: { search: { enabled: false } } } };
  return {
    raw: JSON.stringify(config),
    hash: "capability-menu-height-config",
    sourceConfig: config,
    runtimeConfig: config,
    config,
  };
}

suite.define(() => {
  it("constrains long capability views and keeps keyboard focus visible", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 720 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "config.get": configResponse(),
          "sessions.list": sessionsList(),
          "skills.status": {
            workspaceDir: "/tmp/openclaw-e2e/workspace",
            managedSkillsDir: "/tmp/openclaw-e2e/skills",
            skills: Array.from({ length: 36 }, (_, index) => skill(index + 1)),
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      const composer = page.locator(".agent-chat__input");
      await expect.poll(() => composer.isVisible()).toBe(true);
      const dropdown = composer.locator("wa-dropdown.agent-chat__capability-menu");
      const attach = composer.locator("button.agent-chat__input-btn--attach");
      await expect.poll(() => attach.isVisible()).toBe(true);
      await attach.click();
      await dropdown.locator('[value="open-skills"]').click();
      await expect.poll(() => dropdown.getAttribute("data-view")).toBe("skills");

      const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
      const captureStage = process.env.OPENCLAW_UI_E2E_CAPTURE_STAGE?.trim();
      const capture = async (theme: "dark" | "light") => {
        if (!artifactDir) {
          return;
        }
        await fs.mkdir(artifactDir, { recursive: true });
        await page.evaluate((mode) => {
          document.documentElement.dataset.themeMode = mode;
        }, theme);
        await page.waitForTimeout(50);
        if (captureStage === "after") {
          const menuCenter = await dropdown.evaluate((node) => {
            const menu = node.shadowRoot?.querySelector<HTMLElement>('[part="menu"]');
            if (!menu) {
              throw new Error("expected capability menu bounds");
            }
            const rect = menu.getBoundingClientRect();
            return { x: rect.right - 8, y: rect.top + rect.height / 2 };
          });
          await page.mouse.move(menuCenter.x, menuCenter.y);
          await page.mouse.wheel(0, 1);
        }
        const clip = await dropdown.evaluate((node) => {
          const menu = node.shadowRoot?.querySelector<HTMLElement>('[part="menu"]');
          const composerElement = node.closest<HTMLElement>(".agent-chat__input");
          if (!menu || !composerElement) {
            throw new Error("expected capability menu and composer bounds");
          }
          const menuRect = menu.getBoundingClientRect();
          const composerRect = composerElement.getBoundingClientRect();
          return {
            x: Math.max(0, Math.min(menuRect.left, composerRect.left) - 20),
            y: Math.max(0, menuRect.top - 20),
            width:
              Math.max(menuRect.right, composerRect.right) -
              Math.min(menuRect.left, composerRect.left) +
              40,
            height: Math.max(menuRect.bottom, composerRect.bottom) - menuRect.top + 40,
          };
        });
        await page.screenshot({
          path: path.join(artifactDir, `${theme}-${captureStage}.png`),
          clip,
        });
      };

      if (captureStage === "before") {
        await capture("dark");
        await capture("light");
      }

      const layout = await dropdown.evaluate((node) => {
        const menu = node.shadowRoot?.querySelector<HTMLElement>('[part="menu"]');
        const composerElement = node.closest<HTMLElement>(".agent-chat__input");
        const back = node.querySelector<HTMLElement>('[value="back"]');
        if (!menu || !composerElement || !back) {
          throw new Error("expected capability menu layout");
        }
        menu.scrollTop = Math.floor((menu.scrollHeight - menu.clientHeight) / 2);
        const menuRect = menu.getBoundingClientRect();
        const backRect = back.getBoundingClientRect();
        const style = getComputedStyle(menu);
        return {
          backOffset: backRect.top - menuRect.top,
          clientHeight: menu.clientHeight,
          maxHeight: Number.parseFloat(style.maxHeight),
          overscrollY: style.overscrollBehaviorY,
          scrollHeight: menu.scrollHeight,
          scrollTop: menu.scrollTop,
          token: Number.parseFloat(
            getComputedStyle(composerElement).getPropertyValue(
              "--chat-composer-popover-max-height",
            ),
          ),
        };
      });
      expect(layout.scrollHeight).toBeGreaterThan(layout.clientHeight);
      expect(layout.scrollTop).toBeGreaterThan(0);
      expect(layout.maxHeight).toBeLessThanOrEqual(layout.token + 1);
      expect(layout.overscrollY).toBe("contain");
      expect(layout.backOffset).toBeGreaterThanOrEqual(0);
      expect(layout.backOffset).toBeLessThanOrEqual(1);

      const back = dropdown.locator('[value="back"]');
      await back.focus();
      await back.press("End");
      await expect
        .poll(() =>
          dropdown.evaluate((node) => {
            const menu = node.shadowRoot?.querySelector<HTMLElement>('[part="menu"]');
            const active = document.activeElement;
            if (!menu || !(active instanceof HTMLElement)) {
              return false;
            }
            const menuRect = menu.getBoundingClientRect();
            const activeRect = active.getBoundingClientRect();
            return activeRect.top >= menuRect.top && activeRect.bottom <= menuRect.bottom;
          }),
        )
        .toBe(true);

      await back.click();
      await dropdown.locator('[value="open-connectors"]').click();
      await expect.poll(() => dropdown.getAttribute("data-view")).toBe("connectors");
      expect(
        await dropdown.evaluate((node) => {
          const menu = node.shadowRoot?.querySelector<HTMLElement>('[part="menu"]');
          return Boolean(menu && menu.scrollHeight > menu.clientHeight);
        }),
      ).toBe(true);

      await dropdown.locator('[value="back"]').click();
      await dropdown.locator('[value="open-skills"]').click();
      await dropdown.evaluate((node) => {
        const menu = node.shadowRoot?.querySelector<HTMLElement>('[part="menu"]');
        if (menu) {
          menu.scrollTop = Math.floor((menu.scrollHeight - menu.clientHeight) / 2);
        }
      });
      if (captureStage === "after") {
        await capture("dark");
        await capture("light");
      }
    });
  });
});
