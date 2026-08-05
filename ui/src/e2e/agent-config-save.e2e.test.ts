// Control UI E2E proves per-agent config writes use the canonical keyed shape.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "agent-config-save");

let browser: Browser;
let server: ControlUiE2eServer;

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected object value");
  }
  return value as Record<string, unknown>;
}

describeControlUiE2e("Control UI agent config save", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("submits keyed entries and surfaces Gateway validation failures", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const config = {
      agents: {
        entries: {
          main: {
            default: true,
            tools: { profile: "full" },
          },
        },
      },
    };
    const gateway = await installMockGateway(page, {
      assistantName: "Main agent",
      defaultAgentId: "main",
      methodResponses: {
        "agents.list": {
          agents: [{ id: "main", name: "Main agent" }],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "config.get": {
          config,
          sourceConfig: config,
          runtimeConfig: config,
          hash: "agent-config-hash-1",
          issues: [],
          raw: JSON.stringify(config),
          valid: true,
        },
        "tools.catalog": {
          agentId: "main",
          profiles: [{ id: "full", label: "Full" }],
          groups: [
            {
              id: "fs",
              label: "Files",
              source: "core",
              tools: [
                {
                  id: "read",
                  label: "read",
                  description: "Read files",
                  source: "core",
                  defaultProfiles: ["full"],
                },
              ],
            },
          ],
        },
        "tools.effective": {
          agentId: "main",
          profile: "full",
          groups: [],
          notices: [],
        },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}settings/agents/main/tools`);
      expect(response?.status()).toBe(200);
      await gateway.waitForRequest("agents.list");
      await gateway.waitForRequest("config.get");
      await gateway.waitForRequest("tools.catalog");

      await page
        .locator(".agent-tools-group")
        .filter({ hasText: "Files" })
        .locator(".agent-tools-group__summary")
        .click();
      await gateway.deferNext("config.set");
      await page.locator("#agent-tool-read wa-switch").click();

      const request = await gateway.waitForRequest("config.set");
      const params = requireRecord(request.params);
      const raw = requireRecord(JSON.parse(String(params.raw)));
      expect(raw).toEqual({
        agents: {
          entries: {
            main: {
              default: true,
              tools: { profile: "full", deny: ["read"] },
            },
          },
        },
      });
      expect(requireRecord(raw.agents)).not.toHaveProperty("list");
      expect(params.baseHash).toBe("agent-config-hash-1");

      await gateway.rejectDeferred("config.set", {
        code: "INVALID_REQUEST",
        message: "mock validation failure",
      });
      await page.getByRole("alert").filter({ hasText: "mock validation failure" }).waitFor();

      if (captureUiProof) {
        await mkdir(proofDir, { recursive: true });
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(proofDir, "01-save-error.png"),
        });
      }
    } finally {
      await context.close();
    }
  });
});
