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

function toolsEffectiveResponse() {
  return {
    agentId: "main",
    profile: "full",
    groups: [
      {
        id: "mcp",
        label: "MCP",
        source: "mcp",
        tools: Array.from({ length: 28 }, (_, index) => {
          const number = String(index + 1).padStart(2, "0");
          return {
            id: `mcp_connector_00_tool_${number}`,
            label: `Project tool ${number}`,
            description: `Operate on project resource ${number}`,
            rawDescription: `Operate on project resource ${number}`,
            source: "mcp",
            mcpServer: "connector-00",
            mcpToolName: `project-tool-${number}`,
          };
        }),
      },
    ],
  };
}

suite.define(() => {
  it("caps every long capability view at 420px and keeps keyboard focus visible", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "sessions.patch", "tools.effective"],
        historyMessages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Review the release dashboard and flag anything that needs attention.",
              },
            ],
            timestamp: Date.now() - 60_000,
          },
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "The rollout is healthy. I found two follow-ups:\n\n- Confirm the mobile smoke lane\n- Review the connector permission changes",
              },
            ],
            timestamp: Date.now() - 30_000,
          },
        ],
        methodResponses: {
          "config.get": configResponse(),
          "sessions.list": sessionsList(),
          "skills.status": {
            workspaceDir: "/tmp/openclaw-e2e/workspace",
            managedSkillsDir: "/tmp/openclaw-e2e/skills",
            skills: Array.from({ length: 36 }, (_, index) => skill(index + 1)),
          },
          "tools.effective": toolsEffectiveResponse(),
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
      const capture = async (view: string, theme: "dark" | "light") => {
        if (!artifactDir || !captureStage) {
          return;
        }
        await fs.mkdir(artifactDir, { recursive: true });
        await page.evaluate((mode) => {
          document.documentElement.dataset.themeMode = mode;
        }, theme);
        await page.waitForTimeout(50);
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
        await page.screenshot({
          path: path.join(artifactDir, `${view}-${theme}-${captureStage}.png`),
        });
      };

      const inspectView = async (view: string) => {
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
            viewportHeight: window.innerHeight,
          };
        });
        await capture(view, "dark");
        await capture(view, "light");
        return { ...layout, view };
      };

      const layouts = [await inspectView("skills")];

      const back = dropdown.locator('[value="back"]');
      const interactionTarget = dropdown.locator('[value="skill:19"]');
      const captureInteraction = async (state: "focus" | "hover", theme: "dark" | "light") => {
        await page.evaluate((mode) => {
          document.documentElement.dataset.themeMode = mode;
        }, theme);
        await interactionTarget.scrollIntoViewIfNeeded();

        if (state === "hover") {
          await interactionTarget.hover();
          await expect
            .poll(() => interactionTarget.evaluate((node) => node.matches(":hover")))
            .toBe(true);
        } else {
          await back.focus();
          await page.keyboard.press("Home");
          for (let index = 0; index < 20; index += 1) {
            await page.keyboard.press("ArrowDown");
          }
          await page.mouse.move(900, 500);
          await expect
            .poll(() =>
              interactionTarget.evaluate(
                (node) => document.activeElement === node && node.matches(":focus-visible"),
              ),
            )
            .toBe(true);
        }

        await expect
          .poll(() =>
            dropdown.evaluate((node, target) => {
              const menu = node.shadowRoot?.querySelector<HTMLElement>('[part="menu"]');
              const backRow = node.querySelector<HTMLElement>('[value="back"]');
              const targetRow = node.querySelector<HTMLElement>(target);
              if (!menu || !backRow || !targetRow) {
                return false;
              }
              const menuRect = menu.getBoundingClientRect();
              const backRect = backRow.getBoundingClientRect();
              const targetRect = targetRow.getBoundingClientRect();
              return (
                menu.scrollTop > 0 &&
                menu.scrollHeight > menu.clientHeight &&
                backRect.top >= menuRect.top &&
                backRect.bottom <= menuRect.bottom &&
                targetRect.top >= menuRect.top &&
                targetRect.bottom <= menuRect.bottom
              );
            }, '[value="skill:19"]'),
          )
          .toBe(true);

        await expect
          .poll(() =>
            interactionTarget.evaluate((node) => {
              const probe = document.createElement("div");
              probe.style.backgroundColor = "var(--bg-hover)";
              probe.style.color = "var(--text)";
              document.body.append(probe);
              const rowStyle = getComputedStyle(node);
              const probeStyle = getComputedStyle(probe);
              const matches =
                rowStyle.backgroundColor === probeStyle.backgroundColor &&
                rowStyle.color === probeStyle.color;
              probe.remove();
              return matches;
            }),
          )
          .toBe(true);

        if (artifactDir && captureStage === "after") {
          await page.waitForTimeout(50);
          await page.screenshot({
            path: path.join(artifactDir, `skill-20-${state}-${theme}-after.png`),
          });
        }
      };

      await captureInteraction("hover", "dark");
      await captureInteraction("hover", "light");
      await captureInteraction("focus", "dark");
      await captureInteraction("focus", "light");

      await back.click();
      await dropdown.locator('[value="open-connectors"]').click();
      await expect.poll(() => dropdown.getAttribute("data-view")).toBe("connectors");
      layouts.push(await inspectView("connectors"));

      await dropdown.locator('[value="tools:0"]').click();
      await expect.poll(() => dropdown.getAttribute("data-view")).toBe("tools:connector-00");
      await expect.poll(() => dropdown.getByText("28 of 28 tools on").isVisible()).toBe(true);
      layouts.push(await inspectView("tool-access"));

      if (artifactDir && captureStage) {
        await fs.writeFile(
          path.join(artifactDir, `${captureStage}-layout.json`),
          `${JSON.stringify(layouts, null, 2)}\n`,
        );
      }

      for (const layout of layouts) {
        const compactHeightCap = Math.min(layout.token, 420, layout.viewportHeight * 0.5);
        expect(compactHeightCap).toBe(420);
        expect(layout.scrollHeight).toBeGreaterThan(layout.clientHeight);
        expect(layout.scrollTop).toBeGreaterThan(0);
        expect(layout.maxHeight).toBeGreaterThanOrEqual(compactHeightCap - 1);
        expect(layout.maxHeight).toBeLessThanOrEqual(compactHeightCap + 1);
        expect(layout.clientHeight).toBeLessThanOrEqual(compactHeightCap + 1);
        expect(layout.overscrollY).toBe("contain");
        expect(layout.backOffset).toBeGreaterThanOrEqual(0);
        expect(layout.backOffset).toBeLessThanOrEqual(1);
      }
    });
  });
});
