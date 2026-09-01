import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { finishElementAnimations } from "../test-helpers/animations.ts";
import { controlUiBundledGatewayUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

const themeCases = [
  { family: "claw", mode: "dark", resolved: "dark" },
  { family: "claw", mode: "light", resolved: "light" },
  { family: "knot", mode: "dark", resolved: "openknot" },
  { family: "knot", mode: "light", resolved: "openknot-light" },
  { family: "dash", mode: "dark", resolved: "dash" },
  { family: "dash", mode: "light", resolved: "dash-light" },
  { family: "absolutely", mode: "dark", resolved: "absolutely" },
  { family: "absolutely", mode: "light", resolved: "absolutely-light" },
  { family: "tide", mode: "dark", resolved: "tide" },
  { family: "tide", mode: "light", resolved: "tide-light" },
  { family: "beacon", mode: "dark", resolved: "beacon" },
  { family: "beacon", mode: "light", resolved: "beacon-light" },
  { family: "phosphor", mode: "dark", resolved: "phosphor" },
  { family: "phosphor", mode: "light", resolved: "phosphor-light" },
  { family: "crt", mode: "dark", resolved: "crt" },
  { family: "crt", mode: "light", resolved: "crt-light" },
  { family: "manuscript", mode: "dark", resolved: "manuscript" },
  { family: "manuscript", mode: "light", resolved: "manuscript-light" },
  { family: "rose", mode: "dark", resolved: "rose" },
  { family: "rose", mode: "light", resolved: "rose-light" },
  { family: "miami", mode: "dark", resolved: "miami" },
  { family: "miami", mode: "light", resolved: "miami-light" },
] as const;

const textTokens = [
  "--text",
  "--text-strong",
  "--chat-text",
  "--muted",
  "--muted-strong",
  "--muted-foreground",
] as const;

const surfaceTokens = ["--bg", "--bg-elevated", "--bg-muted", "--card", "--panel"] as const;

function themeConfigResponse(
  family:
    | "claw"
    | "knot"
    | "dash"
    | "absolutely"
    | "tide"
    | "beacon"
    | "phosphor"
    | "crt"
    | "manuscript"
    | "rose"
    | "miami",
  mode: "dark" | "light",
  accent?: string,
) {
  const config = {
    ui: { prefs: { ...(family === "claw" ? {} : { theme: family }), themeMode: mode, accent } },
  };
  const hash = `theme-contrast-${family}-${mode}`;
  return {
    appliedConfigHash: hash,
    config,
    configRevisionHash: hash,
    hash,
    issues: [],
    raw: JSON.stringify(config),
    valid: true,
  };
}

type RenderedColor = {
  red: number;
  green: number;
  blue: number;
  alpha: number;
};

function parseRenderedColor(color: string): RenderedColor {
  const trimmed = color.trim();
  const shortHex = /^#([a-f\d])([a-f\d])([a-f\d])$/iu.exec(trimmed);
  const hex = shortHex ?? /^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/iu.exec(trimmed);
  if (hex) {
    const channels = hex
      .slice(1)
      .map((channel) => Number.parseInt(shortHex ? channel.repeat(2) : channel, 16));
    const [red, green, blue] = channels;
    if (red !== undefined && green !== undefined && blue !== undefined) {
      return { alpha: 1, blue, green, red };
    }
  }

  const rgb =
    /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*(\d*\.?\d+))?\s*\)$/u.exec(
      trimmed,
    );
  const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)$/u.exec(
    trimmed,
  );
  const rendered = rgb ?? srgb;
  if (rendered) {
    const [red, green, blue] = rendered
      .slice(1, 4)
      .map((value) => Number(value) * (srgb ? 255 : 1));
    const alpha = rendered[4] === undefined ? 1 : Number(rendered[4]);
    if (
      red !== undefined &&
      green !== undefined &&
      blue !== undefined &&
      [red, green, blue].every((channel) => channel >= 0 && channel <= 255) &&
      alpha >= 0 &&
      alpha <= 1
    ) {
      return { alpha, blue, green, red };
    }
  }

  throw new Error(`Expected a browser-rendered RGB or theme hex color, received ${color}`);
}

function compositeColor(foreground: RenderedColor, background: RenderedColor): RenderedColor {
  if (background.alpha !== 1) {
    throw new Error("Cannot measure rendered contrast against a transparent background");
  }
  const blend = (front: number, back: number) =>
    front * foreground.alpha + back * (1 - foreground.alpha);
  return {
    alpha: 1,
    blue: blend(foreground.blue, background.blue),
    green: blend(foreground.green, background.green),
    red: blend(foreground.red, background.red),
  };
}

function relativeLuminance(color: string | RenderedColor): number {
  const resolved = typeof color === "string" ? parseRenderedColor(color) : color;
  if (resolved.alpha !== 1) {
    throw new Error("Composite a translucent rendered color before calculating contrast");
  }
  const channels = [resolved.red, resolved.green, resolved.blue].map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const [red, green, blue] = channels;
  if (red === undefined || green === undefined || blue === undefined) {
    throw new Error(`Expected three theme color channels, received ${JSON.stringify(resolved)}`);
  }
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string | RenderedColor, background: string | RenderedColor) {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

const suite = createControlUiE2eSuite({
  name: "Control UI browser-rendered muted theme contrast",
  trackBrowserContexts: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is required for theme contrast proof at ${executablePath}`,
});

suite.define(() => {
  it.each(
    themeCases.flatMap(({ family, mode, resolved }) =>
      (family === "claw" ? [undefined, "#000000", "#ffffff"] : [undefined]).map((accent) => ({
        family,
        mode,
        resolved,
        accent,
      })),
    ),
  )(
    "keeps $resolved appearance and picker states legible (accent $accent)",
    async ({ family, mode, resolved, accent }) => {
      const context = await suite.newBrowserContext({
        colorScheme: mode,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      });
      const initialFamily = family === "claw" ? "knot" : "claw";
      await context.addInitScript(
        ({ gatewayUrl, initialMode, initialTheme }) => {
          localStorage.setItem(
            `openclaw.control.settings.v1:${gatewayUrl}`,
            JSON.stringify({ gatewayUrl, theme: initialTheme, themeMode: initialMode }),
          );
        },
        {
          gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl),
          initialMode: mode,
          initialTheme: initialFamily,
        },
      );

      const page = await context.newPage();
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "config.get": themeConfigResponse(initialFamily, mode, accent),
        },
      });

      try {
        const response = await page.goto(`${suite.server.baseUrl}settings/appearance`);
        expect(response?.status()).toBe(200);

        const selectedCard = page.locator(`.settings-theme-card--${family}`);
        await selectedCard.waitFor({ state: "visible" });
        await gateway.waitForRequest("config.get");
        const initialConfigGets = (await gateway.getRequests("config.get")).length;
        const committed = themeConfigResponse(family, mode, accent);
        await gateway.deferNext("config.patch");
        await selectedCard.click();
        const patch = await gateway.waitForRequest("config.patch");
        const raw = (patch.params as { raw?: unknown } | undefined)?.raw;
        expect(typeof raw).toBe("string");
        expect(JSON.parse(String(raw))).toMatchObject({
          ui: { prefs: { theme: family === "claw" ? null : family } },
        });

        // Theme clicks apply immediately; the eventual Gateway acknowledgement must not revert them.
        await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe(resolved);
        await expect
          .poll(() => selectedCard.getAttribute("class"))
          .toContain("settings-theme-card--active");

        await gateway.setMethodResponse("config.get", committed);
        await gateway.resolveDeferred("config.patch", committed);
        await expect
          .poll(async () => (await gateway.getRequests("config.get")).length)
          .toBe(initialConfigGets + 1);

        await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe(resolved);
        await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe(mode);
        await expect
          .poll(() => selectedCard.getAttribute("class"))
          .toContain("settings-theme-card--active");

        const visibleDescription = page.locator(".settings-section__desc").first();
        await visibleDescription.waitFor({ state: "visible" });

        const rendered = await page.evaluate(
          ({ foregroundNames, surfaceNames }) => {
            const styles = getComputedStyle(document.documentElement);
            const description = document.querySelector<HTMLElement>(".settings-section__desc");
            if (!description) {
              throw new Error("The actual Appearance settings description did not render");
            }
            let opacity = 1;
            const backgroundLayers: string[] = [];
            for (
              let ancestor: HTMLElement | null = description;
              ancestor;
              ancestor = ancestor.parentElement
            ) {
              const ancestorStyles = getComputedStyle(ancestor);
              opacity *= Number(ancestorStyles.opacity);
              backgroundLayers.push(ancestorStyles.backgroundColor);
            }
            return {
              backgroundLayers,
              descriptionColor: getComputedStyle(description).color,
              descriptionOpacity: opacity,
              foregrounds: Object.fromEntries(
                foregroundNames.map((name) => [name, styles.getPropertyValue(name).trim()]),
              ) as Record<string, string>,
              surfaces: Object.fromEntries(
                surfaceNames.map((name) => [name, styles.getPropertyValue(name).trim()]),
              ) as Record<string, string>,
            };
          },
          { foregroundNames: [...textTokens], surfaceNames: [...surfaceTokens] },
        );

        const pairings = textTokens.flatMap((textToken) =>
          surfaceTokens.map((surfaceToken) => {
            const foreground = rendered.foregrounds[textToken];
            const background = rendered.surfaces[surfaceToken];
            if (!foreground || !background) {
              throw new Error(`Missing browser-resolved ${textToken} or ${surfaceToken}`);
            }
            const contrast = contrastRatio(foreground, background);
            expect(
              contrast,
              `${resolved}: ${textToken} ${foreground} on ${surfaceToken} ${background}`,
            ).toBeGreaterThanOrEqual(4.5);
            return {
              background,
              contrast: Number(contrast.toFixed(3)),
              foreground,
              surfaceToken,
              textToken,
            };
          }),
        );

        let descriptionBackground = parseRenderedColor(rendered.surfaces["--bg"] ?? "");
        for (const backgroundLayer of rendered.backgroundLayers.toReversed()) {
          descriptionBackground = compositeColor(
            parseRenderedColor(backgroundLayer),
            descriptionBackground,
          );
        }
        const descriptionColor = parseRenderedColor(rendered.descriptionColor);
        const descriptionForeground = compositeColor(
          {
            ...descriptionColor,
            alpha: descriptionColor.alpha * rendered.descriptionOpacity,
          },
          descriptionBackground,
        );
        const descriptionContrast = contrastRatio(descriptionForeground, descriptionBackground);
        expect(
          descriptionContrast,
          `${resolved}: actual rendered muted Appearance description, including ancestor backgrounds and opacity`,
        ).toBeGreaterThanOrEqual(4.5);

        const picker = page.locator("#settings-font-chat");
        await picker.click();
        const selected = picker.locator("wa-option:state(selected)");
        await selected.waitFor({ state: "visible" });
        const optionPaint = async (option: typeof selected) => {
          await option.evaluate(finishElementAnimations);
          return option.evaluate((element) => {
            const style = getComputedStyle(element);
            return {
              background: style.backgroundColor,
              label: getComputedStyle(element.querySelector(".picker-select__label")!).color,
              description: getComputedStyle(element.querySelector(".picker-select__description")!)
                .color,
              outline: style.outlineStyle,
              outlineWidth: Number.parseFloat(style.outlineWidth),
              outlineColor: style.outlineColor,
            };
          });
        };
        // Options are slotted into a shadow listbox: light-DOM ancestors miss its painted surface.
        const listboxBackground = await picker
          .locator('[part="listbox"]')
          .evaluate((element) => getComputedStyle(element).backgroundColor);
        const assertOptionContrast = async (option: typeof selected) => {
          const paint = await optionPaint(option);
          const background = compositeColor(
            parseRenderedColor(paint.background),
            parseRenderedColor(listboxBackground),
          );
          for (const text of [paint.label, paint.description]) {
            expect(
              contrastRatio(text, background),
              `${resolved} picker text`,
            ).toBeGreaterThanOrEqual(4.5);
          }
          return { paint, background };
        };
        const selectedValue = await selected.getAttribute("value");
        const initialPaint = await optionPaint(selected);
        await page.keyboard.press("ArrowDown");
        const current = picker.locator("wa-option:state(current)");
        await expect.poll(() => current.getAttribute("value")).not.toBe(selectedValue);
        expect(await selected.getAttribute("value")).toBe(selectedValue);
        await expect
          .poll(async () => (await optionPaint(selected)).background)
          .toBe(initialPaint.background);
        await assertOptionContrast(selected);
        const focused = await assertOptionContrast(current);
        expect(focused.paint.outline).not.toBe("none");
        expect(focused.paint.outlineWidth).toBeGreaterThanOrEqual(2);
        expect(
          contrastRatio(focused.paint.outlineColor, focused.background),
        ).toBeGreaterThanOrEqual(3);
        await picker.locator('wa-option[value="system"]').hover();
        await assertOptionContrast(picker.locator('wa-option[value="system"]'));
        await page.keyboard.press("Escape");
        expect(new URL(page.url()).pathname).toBe("/settings/appearance");
        expect(await selected.getAttribute("value")).toBe(selectedValue);

        if (captureUiProof) {
          await mkdir(path.join(suite.artifactDir, "theme-muted-contrast"), { recursive: true });
          const proofName = accent ? `${resolved}-${accent.slice(1)}` : resolved;
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(
              path.join(suite.artifactDir, "theme-muted-contrast"),
              `${proofName}.png`,
            ),
          });
          await writeFile(
            path.join(path.join(suite.artifactDir, "theme-muted-contrast"), `${proofName}.json`),
            `${JSON.stringify(
              {
                accent,
                description: {
                  background: descriptionBackground,
                  contrast: Number(descriptionContrast.toFixed(3)),
                  foreground: descriptionForeground,
                  opacity: rendered.descriptionOpacity,
                },
                mode,
                pairings,
                resolved,
                selectedFamily: family,
              },
              null,
              2,
            )}\n`,
          );
        }
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it("keeps the actual Skill Workshop Today view within a 390px mobile viewport", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 844, width: 390 },
      },
      async ({ page }) => {
        const updatedAt = "2026-07-29T10:00:00.000Z";
        const proposal = {
          createdAt: updatedAt,
          description: "Clean inbox triage",
          id: "proposal-1",
          kind: "create",
          scanState: "clean",
          skillKey: "inbox-cleaner",
          skillName: "Inbox Cleaner",
          status: "pending",
          title: "Inbox Cleaner",
          updatedAt,
        };
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": themeConfigResponse("claw", "light"),
            "skills.proposals.inspect": {
              content: "Review unread mail and archive low-priority threads.",
              record: {
                createdAt: updatedAt,
                description: proposal.description,
                id: proposal.id,
                kind: proposal.kind,
                proposedVersion: "v1",
                status: proposal.status,
                target: { skillKey: proposal.skillKey, skillName: proposal.skillName },
                title: proposal.title,
                updatedAt,
              },
              supportFiles: [],
            },
            "skills.proposals.list": {
              proposals: [proposal],
              schema: "openclaw.skill-workshop.proposals-manifest.v1",
              updatedAt,
            },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}skills/workshop`);
        expect(response?.status()).toBe(200);
        await gateway.waitForRequest("skills.proposals.list");

        const todayTab = page.locator("#skill-workshop-mode-tab-today");
        await todayTab.waitFor({ state: "visible" });
        await todayTab.click();

        const today = page.locator(".sw-today");
        await today.waitFor({ state: "visible" });
        const rendered = await today.evaluate((element) => {
          const styles = getComputedStyle(element);
          return {
            bodyWidth: document.body.scrollWidth,
            boxSizing: styles.boxSizing,
            clientWidth: element.clientWidth,
            parentWidth: element.parentElement?.clientWidth ?? 0,
            scrollWidth: element.scrollWidth,
            viewportWidth: window.innerWidth,
            width: element.getBoundingClientRect().width,
          };
        });

        expect(rendered.viewportWidth).toBe(390);
        expect(rendered.boxSizing).toBe("border-box");
        expect(rendered.width).toBeLessThanOrEqual(rendered.parentWidth);
        expect(rendered.scrollWidth).toBeLessThanOrEqual(rendered.clientWidth);
        expect(rendered.bodyWidth).toBeLessThanOrEqual(rendered.viewportWidth);

        if (captureUiProof) {
          await mkdir(path.join(suite.artifactDir, "theme-muted-contrast"), { recursive: true });
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(
              path.join(suite.artifactDir, "theme-muted-contrast"),
              "skill-workshop-today-mobile.png",
            ),
          });
          await writeFile(
            path.join(
              path.join(suite.artifactDir, "theme-muted-contrast"),
              "skill-workshop-today-mobile.json",
            ),
            `${JSON.stringify(rendered, null, 2)}\n`,
          );
        }
      },
    );
  });
});
