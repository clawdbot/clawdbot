import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium, webkit, type Browser } from "playwright";
import { expect, it } from "vitest";
import {
  CONTROL_UI_ASSET_MANIFEST_FILENAME,
  CONTROL_UI_ASSET_MANIFEST_VERSION,
  hashControlUiAssetManifestEntries,
  type ControlUiAssetManifestEntry,
} from "../../../src/gateway/control-ui-asset-manifest.ts";
import { createControlUiAssetRetention } from "../../../src/gateway/control-ui-asset-retention.ts";
import {
  handleControlUiHttpRequest,
  type ControlUiRootState,
} from "../../../src/gateway/control-ui.ts";
import { withEnvAsync } from "../../../src/test-utils/env.ts";
import { resolvePlaywrightChromiumExecutablePath } from "../test-helpers/control-ui-e2e.ts";

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const useWebKit = process.env.OPENCLAW_CONTROL_UI_E2E_BROWSER === "webkit";
const browserName = useWebKit ? "webkit" : "chromium";
const artifactDir = path.resolve(`.artifacts/control-ui-e2e/retained-assets-${browserName}`);
const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());

async function writeBuild(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  const assets: ControlUiAssetManifestEntry[] = [];
  for (const [relativePath, source] of Object.entries(files)) {
    const contents = Buffer.from(source);
    await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
    await writeFile(path.join(root, relativePath), contents);
    if (relativePath.startsWith("assets/")) {
      assets.push({
        path: relativePath,
        sha256: createHash("sha256").update(contents).digest("hex"),
        size: contents.byteLength,
      });
    }
  }
  assets.sort((left, right) => left.path.localeCompare(right.path));
  const manifest = {
    version: CONTROL_UI_ASSET_MANIFEST_VERSION,
    generation: hashControlUiAssetManifestEntries(assets),
    assets,
  };
  await writeFile(
    path.join(root, CONTROL_UI_ASSET_MANIFEST_FILENAME),
    `${JSON.stringify(manifest)}\n`,
  );
}

async function writeOldDocumentBuild(root: string): Promise<void> {
  await writeBuild(root, {
    "index.html": `<!doctype html>
      <html><head><meta name="viewport" content="width=device-width,initial-scale=1">
      <style>
        body { margin: 0; background: #10141c; color: #eef2ff; font: 16px system-ui; }
        main { box-sizing: border-box; min-height: 100vh; padding: 32px 24px; }
        small { color: #94a3b8; } button { margin: 32px 0; padding: 12px 18px; }
        #route { border-left: 4px solid #4ade80; padding: 12px; }
      </style></head><body><main>
      <small>OpenClaw update recovery proof</small><h1>Old document is still open</h1>
      <button type="button">Open Activity</button><div id="route">Activity not loaded yet</div>
      <script type="module" src="/assets/app-old.js"></script>
      </main></body></html>`,
    "assets/app-old.js": `document.querySelector("button").addEventListener("click", async () => {
      const route = await import("/assets/activity-old.js");
      document.querySelector("#route").textContent = route.message;
    });`,
    "assets/activity-old.js":
      'export const message = "Activity loaded from the retained generation";\n',
  });
}

async function writeReplacementBuild(root: string): Promise<void> {
  await writeBuild(root, {
    "index.html": "<!doctype html><title>Replacement build</title>",
    "assets/current.js": "export const current = true;\n",
  });
}

async function startGatewayAssetServer(root: Extract<ControlUiRootState, { kind: "bundled" }>) {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    requests.push(pathname);
    void handleControlUiHttpRequest(request, response, { root }).then((handled) => {
      if (!handled && !response.writableEnded) {
        response.statusCode = 404;
        response.end("Not Found");
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Retained-asset E2E server did not expose a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

it("keeps an old document's unvisited lazy module available across builds", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "openclaw-retained-assets-e2e-"));
  const buildA = path.join(fixture, "build-a");
  const buildB = path.join(fixture, "build-b");
  const stateDir = path.join(fixture, "state");
  let browser: Browser | undefined;
  let server: Awaited<ReturnType<typeof startGatewayAssetServer>> | undefined;
  try {
    if (captureUiProof) {
      await mkdir(artifactDir, { recursive: true });
    }
    await writeOldDocumentBuild(buildA);
    await writeReplacementBuild(buildB);

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const retainedA = createControlUiAssetRetention(buildA);
      await retainedA.prepare();
      const root: Extract<ControlUiRootState, { kind: "bundled" }> = {
        kind: "bundled",
        path: buildA,
        realPath: await realpath(buildA),
        retainedAssets: retainedA,
      };
      server = await startGatewayAssetServer(root);
      browser = useWebKit
        ? await webkit.launch()
        : await chromium.launch({ executablePath: chromiumExecutablePath });
      const context = await browser.newContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 844, width: 390 },
        ...(captureUiProof
          ? { recordVideo: { dir: artifactDir, size: { height: 844, width: 390 } } }
          : {}),
      });
      const page = await context.newPage();

      expect((await page.goto(server.baseUrl))?.status()).toBe(200);
      await page.getByRole("heading", { name: "Old document is still open" }).waitFor();
      if (captureUiProof) {
        await page.screenshot({ path: path.join(artifactDir, "1-old-document.png") });
        await page.waitForTimeout(750);
      }

      const retainedB = createControlUiAssetRetention(buildB);
      await retainedB.prepare();
      root.path = buildB;
      root.realPath = await realpath(buildB);
      root.retainedAssets = retainedB;
      await rm(buildA, { recursive: true, force: true });
      const requestStart = server.requests.length;

      await page.getByRole("button", { name: "Open Activity" }).click();
      await page.getByText("Activity loaded from the retained generation").waitFor();

      expect(server.requests.slice(requestStart)).toContain("/assets/activity-old.js");
      expect(await page.getByText("Importing a module script failed.").count()).toBe(0);
      if (captureUiProof) {
        await page.screenshot({ path: path.join(artifactDir, "2-retained-activity.png") });
        await page.waitForTimeout(750);
      }

      const video = page.video();
      await context.close();
      if (captureUiProof && video) {
        await rename(
          await video.path(),
          path.join(artifactDir, `retained-assets-${browserName}.webm`),
        );
      }
    });
  } finally {
    await browser?.close();
    await server?.close();
    await rm(fixture, { recursive: true, force: true });
  }
}, 60_000);
