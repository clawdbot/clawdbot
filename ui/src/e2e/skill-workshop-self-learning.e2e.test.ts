// Control UI tests prove self-learning config conflict recovery through the mocked Gateway.
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
  type MockGatewayRequest,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

let browser: Browser;
let server: ControlUiE2eServer;

function configSnapshot(enabled: boolean, hash: string) {
  const config = {
    skills: { workshop: { autonomous: { mode: enabled ? "auto" : "off" } } },
  };
  return {
    config,
    sourceConfig: config,
    hash,
    issues: [],
    raw: JSON.stringify(config),
    valid: true,
  };
}

function emptyProposalManifest() {
  return {
    schema: "openclaw.skill-workshop.proposals-manifest.v1",
    updatedAt: "2026-07-13T12:00:00.000Z",
    proposals: [],
  };
}

function configPatchParams(request: MockGatewayRequest): Record<string, unknown> {
  const params = request.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("Expected config.patch params");
  }
  return params as Record<string, unknown>;
}

async function waitForNextRequest(
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  method: string,
  previousCount: number,
): Promise<MockGatewayRequest> {
  await expect.poll(async () => (await gateway.getRequests(method)).length).toBe(previousCount + 1);
  const requests = await gateway.getRequests(method);
  const request = requests[previousCount];
  if (!request) {
    throw new Error(`Expected ${method} request ${previousCount + 1}`);
  }
  return request;
}

describeControlUiE2e("Skill Workshop self-learning config recovery mocked Gateway E2E", () => {
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

  it("enables self-learning after refreshing and replaying a stale-hash patch", async () => {
    const artifactDir = createControlUiE2eArtifactDir("self-learning-config-retry");
    const context = await browser.newContext({
      locale: "en-US",
      recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } },
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    let mainFrameNavigations = 0;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        mainFrameNavigations += 1;
      }
    });
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "config.get": configSnapshot(false, "hash-stale"),
        "skills.proposals.list": emptyProposalManifest(),
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}skills/workshop`);
      expect(response?.status()).toBe(200);
      const initialNavigationCount = mainFrameNavigations;
      const enableButton = page.getByRole("button", { name: "Enable self-learning", exact: true });
      await enableButton.waitFor();
      await page.screenshot({ path: path.join(artifactDir, "01-disabled.png") });

      const patchCount = (await gateway.getRequests("config.patch")).length;
      const getCount = (await gateway.getRequests("config.get")).length;
      await gateway.deferNext("config.patch");
      await gateway.deferNext("config.patch");
      await enableButton.click();

      const stalePatch = configPatchParams(
        await waitForNextRequest(gateway, "config.patch", patchCount),
      );
      expect(stalePatch.baseHash).toBe("hash-stale");
      expect(JSON.parse(String(stalePatch.raw))).toEqual({
        skills: { workshop: { autonomous: { mode: "auto" } } },
      });

      await gateway.setMethodResponse("config.get", configSnapshot(false, "hash-current"));
      await gateway.rejectDeferred("config.patch", {
        code: "INVALID_REQUEST",
        message: "config changed since last load; re-run config.get and retry",
      });

      await waitForNextRequest(gateway, "config.get", getCount);
      const replayedPatch = configPatchParams(
        await waitForNextRequest(gateway, "config.patch", patchCount + 1),
      );
      expect(replayedPatch.baseHash).toBe("hash-current");

      await gateway.setMethodResponse("config.get", configSnapshot(true, "hash-enabled"));
      await gateway.resolveDeferred("config.patch", { ok: true });

      const toggle = page.getByLabel("Toggle autonomous self-learning", { exact: true });
      await expect.poll(() => toggle.isChecked()).toBe(true);
      expect(await page.locator(".sw-error").count()).toBe(0);
      expect(mainFrameNavigations).toBe(initialNavigationCount);
      await page.screenshot({ path: path.join(artifactDir, "02-enabled.png") });
    } finally {
      await context.close();
    }
  });
});
