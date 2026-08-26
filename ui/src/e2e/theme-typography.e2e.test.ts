import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { controlUiBundledGatewayUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { requireRecord, requireString } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

/*
 * A theme that declares webfonts must actually paint in them, and a theme that
 * does not must never pay for them. Both halves are invisible to unit tests:
 * the stylesheet is linked at runtime and the faces only resolve once the
 * browser has fetched them, so a broken asset path or a dropped link degrades
 * silently to the fallback stack and looks merely "a bit off".
 */

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDirectory = path.resolve(process.cwd(), ".artifacts/control-ui-e2e/theme-typography");

const suite = createControlUiE2eSuite({
  name: "Control UI theme typography",
  trackBrowserContexts: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is required for theme typography proof at ${executablePath}`,
});

function themeConfigResponse(theme: string, mode: "dark" | "light") {
  const config = { ui: { prefs: { theme, themeMode: mode } } };
  const hash = `theme-typography-${theme}-${mode}`;
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

async function openThemedChat(theme: string, mode: "dark" | "light", basePath = "") {
  const context = await suite.newBrowserContext({
    colorScheme: mode,
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 900, width: 1440 },
  });
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
      initialTheme: theme,
    },
  );
  const page = await context.newPage();
  const fontRequests: string[] = [];
  page.on("response", (response) => {
    const url = response.url();
    if (url.includes("/fonts/")) {
      fontRequests.push(`${url.split("/").pop()} ${response.status()}`);
    }
  });
  const gateway = await installMockGateway(page, {
    ...(basePath ? { basePath } : {}),
    methodResponses: { "config.get": themeConfigResponse(theme, mode) },
  });
  return { fontRequests, gateway, page };
}

async function renderAssistantProse(
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  page: Awaited<ReturnType<typeof openThemedChat>>["page"],
) {
  await page.locator(".agent-chat__composer-combobox textarea").fill("say something");
  await page.getByRole("button", { name: "Send message" }).click();
  const sendRequest = await gateway.waitForRequest("chat.send");
  const runId = requireString(
    requireRecord(sendRequest.params).idempotencyKey,
    "chat send idempotency key",
  );
  const text =
    "Typography carries the theme: chat prose renders in the reading face while chrome, chips, and code keep their own.";
  await gateway.emitGatewayEvent("chat", {
    message: { content: [{ text, type: "text" }], role: "assistant", timestamp: Date.now() },
    runId,
    sessionKey: "main",
    state: "final",
  });
  // first() is the prompt this test just sent; the assistant reply is last.
  await expect.poll(() => page.locator(".chat-text").last().textContent()).toContain("Typography");
}

suite.define(() => {
  it("paints Absolutely chrome and chat prose in its own faces", async () => {
    if (captureUiProof) {
      await mkdir(proofDirectory, { recursive: true });
    }
    const { fontRequests, gateway, page } = await openThemedChat("absolutely", "dark");
    await page.goto(`${suite.server.baseUrl}chat`);
    await renderAssistantProse(gateway, page);

    const report = await page.evaluate(async () => {
      await document.fonts.ready;
      const chats = document.querySelectorAll(".chat-text");
      const chat = chats[chats.length - 1];
      // Computed families come back quoted ('"Space Grotesk", -apple-system…');
      // the first entry is the one that actually paints.
      const primary = (value: string) =>
        (value.split(",")[0] ?? "").trim().replace(/^["']|["']$/gu, "");
      return {
        chatFontFamily: chat ? primary(getComputedStyle(chat).fontFamily) : null,
        bodyFontFamily: primary(getComputedStyle(document.body).fontFamily),
        linkHref: document.getElementById("openclaw-theme-fonts")?.getAttribute("href") ?? null,
        loaded: [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family),
      };
    });

    expect(report.linkHref).toBe("/fonts/absolutely.css");
    // The declared face must win, not merely appear somewhere in the stack.
    expect(report.bodyFontFamily).toBe("Space Grotesk");
    expect(report.chatFontFamily).toBe("Lora");
    expect(new Set(report.loaded)).toEqual(new Set(["Space Grotesk", "Lora"]));
    expect(fontRequests.every((entry) => entry.endsWith(" 200"))).toBe(true);

    if (captureUiProof) {
      await page.screenshot({ path: path.join(proofDirectory, "absolutely-chat-dark.png") });
    }
  });

  it("resolves the font stylesheet against a configured mount path", async () => {
    // A gateway mounted at a base path serves the bundle below that prefix, so
    // root-absolute font URLs 404 there and the theme silently falls back to
    // system faces while its palette still applies.
    const basePath = "/openclaw";
    const { page } = await openThemedChat("absolutely", "dark", basePath);
    const requested: string[] = [];
    await page.route(`**${basePath}/fonts/**`, async (route) => {
      const { pathname } = new URL(route.request().url());
      requested.push(pathname);
      await route.fulfill({ status: 404, body: "", contentType: "text/css" });
    });

    await page.goto(`${suite.server.baseUrl}${basePath.slice(1)}/chat`);
    await page
      .locator(".agent-chat__composer-combobox textarea")
      .waitFor({ state: "visible", timeout: 30_000 });

    const linkHref = await page.evaluate(
      () => document.getElementById("openclaw-theme-fonts")?.getAttribute("href") ?? null,
    );

    expect(linkHref).toBe(`${basePath}/fonts/absolutely.css`);
    // The browser must actually fetch below the mount, not at the root.
    await expect.poll(() => requested).toContain(`${basePath}/fonts/absolutely.css`);
  });

  it("leaves themes without declared faces on the system stack", async () => {
    if (captureUiProof) {
      await mkdir(proofDirectory, { recursive: true });
    }
    const { fontRequests, gateway, page } = await openThemedChat("claw", "dark");
    await page.goto(`${suite.server.baseUrl}chat`);
    await renderAssistantProse(gateway, page);

    const report = await page.evaluate(async () => {
      await document.fonts.ready;
      const primary = (value: string) =>
        (value.split(",")[0] ?? "").trim().replace(/^["']|["']$/gu, "");
      return {
        bodyFontFamily: primary(getComputedStyle(document.body).fontFamily),
        linkHref: document.getElementById("openclaw-theme-fonts")?.getAttribute("href") ?? null,
        loaded: [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family),
      };
    });

    expect(report.linkHref).toBeNull();
    expect(report.loaded).toEqual([]);
    expect(report.bodyFontFamily).not.toBe("Space Grotesk");
    // The default path must not fetch a font asset at all.
    expect(fontRequests).toEqual([]);

    if (captureUiProof) {
      await page.screenshot({ path: path.join(proofDirectory, "claw-chat-dark.png") });
    }
  });
});
