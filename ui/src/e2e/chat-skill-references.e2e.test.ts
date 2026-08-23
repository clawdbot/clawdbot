// Control UI E2E tests cover composable skill references in the chat composer.
import path from "node:path";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI skill references",
});

async function setComposerCaret(composer: Locator, caret: number) {
  await composer.evaluate((element, position) => {
    if (!(element instanceof HTMLTextAreaElement)) {
      throw new Error("Chat composer is not a textarea");
    }
    element.setSelectionRange(position, position);
  }, caret);
}

type FriendlyTokenGeometry = {
  clipped: number;
  gap: number;
  label?: string;
  overflow: number;
};

suite.define(() => {
  it("references multiple skills inside a normal prompt and sends the visible tokens", async () => {
    const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    await suite.withPage(
      {
        viewport: { width: 1280, height: 900 },
        ...(artifactDir
          ? { recordVideo: { dir: artifactDir, size: { width: 1280, height: 900 } } }
          : {}),
      },
      async ({ page }) => {
        const commands = [
          {
            acceptsArgs: true,
            description: "Pre-commit and ship code review.",
            name: "autoreview",
            skillDisplayName: "Auto Review",
            scope: "both",
            source: "skill",
            skillModelVisible: true,
            textAliases: ["/autoreview"],
          },
          {
            acceptsArgs: true,
            description: "Exercise friendly token labels.",
            name: "bench_skill_01",
            skillDisplayName: "Bench Skill 01",
            scope: "both",
            source: "skill",
            skillModelVisible: true,
            textAliases: ["/bench_skill_01"],
          },
          {
            acceptsArgs: true,
            description: "Build and review technical documentation.",
            name: "technical_documentation",
            skillDisplayName: "Technical Documentation",
            scope: "both",
            source: "skill",
            skillModelVisible: true,
            textAliases: ["/technical_documentation"],
          },
          {
            acceptsArgs: true,
            description: "Prepare a detailed status report.",
            name: "status_report",
            skillDisplayName: "Status Report",
            scope: "both",
            source: "skill",
            skillModelVisible: true,
            textAliases: ["/status_report"],
          },
          {
            acceptsArgs: true,
            description: "Exercise wrapped token geometry.",
            name: "wrap",
            skillDisplayName: "Extremely Detailed Wrapped Composition Helper",
            scope: "both",
            source: "skill",
            skillModelVisible: true,
            textAliases: ["/wrap"],
          },
          {
            acceptsArgs: false,
            description: "Show gateway status.",
            name: "status",
            scope: "both",
            source: "native",
            textAliases: ["/status"],
          },
        ];
        const gateway = await installMockGateway(page, {
          deferredMethods: ["chat.send"],
          methodResponses: {
            "chat.startup": {
              agentsList: {
                agents: [{ id: "main", name: "OpenClaw" }],
                defaultId: "main",
                mainKey: "main",
                scope: "agent",
              },
              messages: [],
              metadata: { commands, models: [] },
              sessionId: "skill-reference-session",
              thinkingLevel: null,
            },
            "commands.list": { commands },
          },
        });

        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("chat.startup");
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.fill("Review this with $auto");

        const picker = page.getByRole("listbox", { name: "Skill references" });
        await picker.waitFor({ state: "visible" });
        await expect.poll(() => picker.getByRole("option").count()).toBe(1);
        await expect
          .poll(() => picker.getByRole("option").first().textContent())
          .toContain("Auto Review");
        if (artifactDir) {
          await page.screenshot({
            path: path.join(artifactDir, "skill-reference-picker.png"),
            fullPage: true,
          });
        }
        await composer.press("Enter");
        await expect.poll(() => composer.inputValue()).toBe("Review this with $autoreview ");

        await composer.fill(`${await composer.inputValue()}and $technical`);
        await expect.poll(() => picker.getByRole("option").count()).toBe(1);
        await composer.press("Tab");
        await expect
          .poll(() => composer.inputValue())
          .toBe("Review this with $autoreview and $technical_documentation ");

        if (artifactDir) {
          await page.screenshot({
            path: path.join(artifactDir, "skill-references-selected.png"),
            fullPage: true,
          });
        }

        await page.getByRole("button", { name: "Send message" }).click();
        const request = await gateway.waitForRequest("chat.send");
        expect((request.params as { message?: unknown }).message).toBe(
          "Review this with $autoreview and $technical_documentation",
        );

        await composer.fill("Print $HOME");
        await expect.poll(() => picker.count()).toBe(0);
        await composer.fill("/");
        await page.getByRole("listbox", { name: "Slash commands" }).waitFor({ state: "visible" });
        await expect.poll(() => page.getByRole("option", { name: /\/status/u }).count()).toBe(2);

        const slashOptions = page
          .getByRole("listbox", { name: "Slash commands" })
          .getByRole("option");
        await composer.fill("/sta");
        await expect
          .poll(async () => {
            const names = await slashOptions.locator(".slash-menu-name").allTextContents();
            return { first: names[0], last: names.at(-1) };
          })
          .toEqual({ first: "/status", last: "/status_report" });
        await composer.press("Tab");
        await expect.poll(() => composer.inputValue()).toBe("/status");

        const readFriendlyTokenGeometry = () =>
          page
            .locator(".agent-chat__composer-draft-overlay")
            .evaluate((element): FriendlyTokenGeometry[] => {
              return Array.from(
                element.querySelectorAll<HTMLElement>(".agent-chat__skill-token"),
              ).map((token) => {
                let sibling: ChildNode | null = token.nextSibling;
                while (sibling && (!(sibling instanceof Text) || !/\S/u.test(sibling.data))) {
                  sibling = sibling.nextSibling;
                }
                if (!(sibling instanceof Text)) {
                  throw new Error("Expected text after skill token");
                }
                const nextWordStart = sibling.data.search(/\S/u);
                const wordRange = document.createRange();
                wordRange.setStart(sibling, nextWordStart);
                wordRange.setEnd(sibling, nextWordStart + 1);
                const wordRect = wordRange.getBoundingClientRect();
                const tokenRect = token.getBoundingClientRect();
                return {
                  clipped: token.scrollWidth - token.clientWidth,
                  gap:
                    getComputedStyle(element).direction === "rtl"
                      ? tokenRect.left - wordRect.right
                      : wordRect.left - tokenRect.right,
                  label: token.textContent?.trim(),
                  overflow:
                    Math.max(0, element.getBoundingClientRect().left - tokenRect.left) +
                    Math.max(0, tokenRect.right - element.getBoundingClientRect().right),
                };
              });
            });

        await composer.fill("Use $bench_skill_01 next and $autoreview later");
        await expect
          .poll(readFriendlyTokenGeometry)
          .toSatisfy((tokens) =>
            tokens?.every(
              (token: FriendlyTokenGeometry) =>
                token.clipped <= 1 &&
                token.gap > 0 &&
                token.overflow <= 1 &&
                ["Bench Skill 01", "Auto Review"].includes(token.label ?? ""),
            ),
          );

        await page.setViewportSize({ width: 390, height: 844 });
        await composer.fill(
          "A mobile line that wraps before $bench_skill_01 next and $autoreview later",
        );
        await expect
          .poll(readFriendlyTokenGeometry)
          .toSatisfy((tokens) =>
            tokens?.every(
              (token: FriendlyTokenGeometry) =>
                token.clipped <= 1 && token.gap > 0 && token.overflow <= 1,
            ),
          );

        await composer.fill("שלום עם $bench_skill_01 הבא ואז $autoreview מאוחר יותר");
        await expect.poll(() => composer.getAttribute("dir")).toBe("rtl");
        await expect
          .poll(readFriendlyTokenGeometry)
          .toSatisfy((tokens) =>
            tokens?.every(
              (token: FriendlyTokenGeometry) =>
                token.clipped <= 1 && token.gap > 0 && token.overflow <= 1,
            ),
          );

        await page.setViewportSize({ width: 420, height: 780 });
        await composer.fill(
          "A wrapped prompt leading into $wrap: then following copy that must share the native textarea wrap.",
        );
        const overlay = page.locator(".agent-chat__composer-draft-overlay");
        const token = overlay.locator(".agent-chat__skill-token");
        await token.waitFor({ state: "visible" });
        await expect.poll(() => token.getAttribute("data-raw")).toBe("$wrap");
        await expect
          .poll(() => overlay.textContent())
          .toSatisfy((text) =>
            text
              ?.replace(/\s+/gu, " ")
              .includes(
                "A wrapped prompt leading into Extremely Detailed Wrapped Composition Helper: then",
              ),
          );
        const [textareaGeometry, overlayGeometry] = await Promise.all([
          composer.evaluate((element) => {
            const style = getComputedStyle(element);
            return {
              clientWidth: element.clientWidth,
              font: style.font,
              lineHeight: style.lineHeight,
              overflowWrap: style.overflowWrap,
              paddingInline: style.paddingInline,
              whiteSpace: style.whiteSpace,
            };
          }),
          overlay.evaluate((element) => {
            const style = getComputedStyle(element);
            return {
              clientWidth: element.clientWidth,
              font: style.font,
              lineHeight: style.lineHeight,
              overflowWrap: style.overflowWrap,
              paddingInline: style.paddingInline,
              whiteSpace: style.whiteSpace,
            };
          }),
        ]);
        expect(overlayGeometry).toEqual(textareaGeometry);

        await composer.evaluate((element) => {
          const surface = element.closest<HTMLElement>(".agent-chat__input");
          if (!surface) {
            throw new Error("Expected the composer surface");
          }
          surface.dataset.composerLayout = "single-line";
        });
        await expect
          .poll(async () =>
            Promise.all([
              composer.evaluate((element) => getComputedStyle(element).whiteSpace),
              overlay.evaluate((element) => getComputedStyle(element).whiteSpace),
            ]),
          )
          .toEqual(["nowrap", "nowrap"]);

        await composer.evaluate((element) => {
          const surface = element.closest<HTMLElement>(".agent-chat__input");
          if (surface) {
            surface.dataset.composerLayout = "multiline";
          }
        });
        await expect
          .poll(() => overlay.evaluate((element) => getComputedStyle(element).whiteSpace))
          .toBe("pre-wrap");

        if (artifactDir) {
          await page.locator(".agent-chat__composer-shell").screenshot({
            path: path.join(artifactDir, "skill-reference-wrapped.png"),
          });
        }

        const rtlDraft = "שלום עם $wrap: וטקסט נוסף שצריך להישאר מיושר עם שדה הכתיבה.";
        const rtlTokenStart = rtlDraft.indexOf("$wrap");
        const rtlTokenEnd = rtlTokenStart + "$wrap".length;
        const rtlDraftWithoutToken = `${rtlDraft.slice(0, rtlTokenStart)}${rtlDraft.slice(
          rtlTokenEnd,
        )}`;
        await composer.fill(rtlDraft);
        await expect.poll(() => composer.getAttribute("dir")).toBe("rtl");
        await expect.poll(() => overlay.getAttribute("dir")).toBe("rtl");
        await token.waitFor({ state: "visible" });

        await setComposerCaret(composer, rtlTokenEnd);
        await composer.press("Backspace");
        await expect.poll(() => composer.inputValue()).toBe(rtlDraftWithoutToken);
        await composer.fill(rtlDraft);
        await setComposerCaret(composer, rtlTokenStart);
        await composer.press("Delete");
        await expect.poll(() => composer.inputValue()).toBe(rtlDraftWithoutToken);
      },
    );
  });
});
