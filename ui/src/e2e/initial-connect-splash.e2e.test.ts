// Control UI tests cover the initial-connect splash shown instead of the
// login gate while the Gateway resolves its first connection attempt.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import photon from "@silvia-odwyer/photon-node";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { beforeEach, afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  takeControlUiElementScreenshot,
  takeControlUiViewportScreenshot,
  waitForControlUiProofSurface,
} from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  canRunPlaywrightChromium,
  controlUiE2eWaitTimeoutMs,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const artifactRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
let artifactDir: string | undefined;
beforeEach(() => {
  artifactDir = artifactRoot
    ? createControlUiE2eArtifactDir("initial-connect-splash", artifactRoot)
    : undefined;
});
const viewport = { height: 900, width: 1280 };

let browser: Browser;
let server: ControlUiE2eServer;
const openContexts = new Set<BrowserContext>();

async function createPage(): Promise<Page> {
  const context = await browser.newContext({
    viewport,
    ...(artifactDir ? { recordVideo: { dir: artifactDir, size: viewport } } : {}),
  });
  openContexts.add(context);
  const page = await context.newPage();
  page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
  return page;
}

function decodeProofPng(png: Buffer) {
  const image = photon.PhotonImage.new_from_byteslice(png);
  try {
    return { width: image.get_width(), height: image.get_height(), data: image.get_raw_pixels() };
  } finally {
    image.free();
  }
}

async function createPageWithoutRecording(): Promise<Page> {
  const context = await browser.newContext();
  openContexts.add(context);
  return context.newPage();
}

async function takeProofScreenshot(page: Page, name: string, content: Locator[]): Promise<Buffer> {
  const png = await takeControlUiViewportScreenshot(
    page,
    page.locator(".connect-splash, .shell"),
    content,
  );
  if (artifactDir) {
    await writeFile(path.join(artifactDir, `${name}.png`), png);
  }
  return png;
}

async function proofContentPainted(page: Page, proof: Buffer, content: Locator): Promise<boolean> {
  const contentBounds = await content.boundingBox();
  expect(contentBounds).not.toBeNull();
  return page.evaluate(
    async ({ png, bounds }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const crop = document.createElement("canvas");
      crop.width = bounds.width;
      crop.height = bounds.height;
      const context = crop.getContext("2d")!;
      context.drawImage(image, -bounds.x, -bounds.y);
      const pixels = context.getImageData(0, 0, crop.width, crop.height).data;
      // Reject a flat (or effectively invisible) crop without fixing the pose or palette.
      return pixels.some(
        (value, index) => index % 4 !== 3 && Math.abs(value - pixels[index % 4]!) > 10,
      );
    },
    { png: proof.toString("base64"), bounds: contentBounds! },
  );
}

async function captureProof(page: Page, name: string, content: Locator[]): Promise<void> {
  if (artifactDir) {
    await takeProofScreenshot(page, name, content);
  }
}

async function traceLoginGateMounts(page: Page): Promise<() => Promise<boolean>> {
  await page.addInitScript(() => {
    const trace = { mounted: false };
    (
      window as Window & {
        openclawLoginGateMountTrace?: typeof trace;
      }
    ).openclawLoginGateMountTrace = trace;
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (
            node instanceof Element &&
            (node.localName === "openclaw-login-gate" || node.querySelector("openclaw-login-gate"))
          ) {
            trace.mounted = true;
          }
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
  return () =>
    page.evaluate(
      () =>
        (
          window as Window & {
            openclawLoginGateMountTrace?: { mounted: boolean };
          }
        ).openclawLoginGateMountTrace?.mounted ?? false,
    );
}

describeControlUiE2e("Control UI initial connect splash E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed or cannot start at ${chromiumExecutablePath}.`,
      );
    }
    server = await startControlUiE2eServer(undefined, { source: true });
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await Promise.all([...openContexts].map((context) => context.close().catch(() => {})));
    await browser?.close();
    await server?.close();
  });

  afterEach(async () => {
    await Promise.all([...openContexts].map((context) => context.close().catch(() => {})));
    openContexts.clear();
  });

  it("shows the splash instead of the login gate while a configured token connects", async () => {
    const page = await createPage();
    const loginGateMounted = await traceLoginGateMounts(page);
    const loginModuleRequests: string[] = [];
    page.on("request", (request) => {
      if (/\/login-gate(?:\.runtime)?\.ts(?:\?|$)/u.test(request.url())) {
        loginModuleRequests.push(request.url());
      }
    });
    const gateway = await installMockGateway(page, { deferredMethods: ["connect"] });

    await page.goto(`${server.baseUrl}#token=e2e-shared-token`);
    await gateway.waitForRequest("connect");
    const splash = page.locator(".connect-splash");
    await splash.waitFor();
    const skeleton = splash.locator(".loading-skeleton");
    await skeleton.waitFor();
    expect(await splash.getAttribute("aria-busy")).toBeNull();
    expect(await splash.locator("openclaw-mascot").count()).toBe(0);
    expect(await page.getByText("Loading panel", { exact: true }).count()).toBe(0);
    expect(await page.locator("openclaw-app-sidebar").count()).toBe(0);
    expect(await page.locator("openclaw-login-gate").count()).toBe(0);
    const proof = await takeProofScreenshot(page, "01-connecting-shimmer", [
      skeleton.locator(".loading-skeleton__composer"),
    ]);
    const painted = await proofContentPainted(page, proof, skeleton);
    expect(painted, "connecting proof must contain the skeleton").toBe(true);
    const highlight = skeleton.locator(".loading-skeleton__composer");
    expect(
      await highlight.evaluate((element) => getComputedStyle(element, "::after").animationName),
    ).toBe("shimmer");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await splash.locator(".connect-splash__sidebar").isVisible()).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      await highlight.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element, "::after").animationDuration),
      ),
    ).toBeLessThanOrEqual(0.00001);
    await captureProof(page, "01-mobile-reduced-motion", [highlight]);
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "no-preference" });

    await gateway.resolveDeferred("connect");
    await page.locator("openclaw-app-shell").waitFor();
    expect(await page.locator(".connect-splash").count()).toBe(0);
    expect(await loginGateMounted()).toBe(false);
    expect(loginModuleRequests).toEqual([]);
    await captureProof(page, "02-connected-content", [
      page.locator(".sidebar-brand"),
      page.locator(".agent-chat__composer-combobox textarea"),
    ]);
  });

  it("shows a shimmer skeleton until the chat route finishes loading", async () => {
    const page = await createPage();
    let chatModuleRequested = false;
    let releaseChatModule!: () => void;
    const chatModuleReady = new Promise<void>((resolve) => {
      releaseChatModule = resolve;
    });
    await page.route(`${new URL(server.baseUrl).origin}/**`, async (route) => {
      if (new URL(route.request().url()).pathname.endsWith("/chat-page.ts")) {
        chatModuleRequested = true;
        await chatModuleReady;
      }
      await route.continue();
    });
    await installMockGateway(page);

    try {
      await page.goto(`${server.baseUrl}chat?session=main`, {
        waitUntil: "domcontentloaded",
      });
      await page.locator("openclaw-app-shell").waitFor();
      await expect.poll(() => chatModuleRequested).toBe(true);

      const loadingState = page.locator(".lazy-view-state--loading");
      await loadingState.waitFor();
      expect(await loadingState.getAttribute("role")).toBe("status");
      expect(await loadingState.getAttribute("aria-label")).toBe("Loading…");
      expect((await loadingState.textContent())?.trim()).toBe("");
      expect(await page.getByText("Loading panel", { exact: true }).count()).toBe(0);

      const skeleton = loadingState.locator(".loading-skeleton");
      await skeleton.waitFor();
      expect(await loadingState.getAttribute("aria-busy")).toBeNull();
      expect(await loadingState.locator("openclaw-mascot").count()).toBe(0);
      await captureProof(page, "03-pending-chat-shimmer", [
        skeleton.locator(".loading-skeleton__composer"),
      ]);

      releaseChatModule();
      await page.locator("openclaw-chat-page").waitFor();
      expect(await loadingState.count()).toBe(0);
      await captureProof(page, "04-loaded-chat-content", [
        page.locator(".sidebar-brand"),
        page.locator(".agent-chat__composer-combobox textarea"),
      ]);
    } finally {
      releaseChatModule();
    }
  });

  it("shows the splash while a credential-less first connection resolves", async () => {
    const page = await createPage();
    const loginGateMounted = await traceLoginGateMounts(page);
    const gateway = await installMockGateway(page, { deferredMethods: ["connect"] });

    await page.goto(server.baseUrl);
    await gateway.waitForRequest("connect");
    await page.locator(".connect-splash").waitFor();
    expect(await page.locator("openclaw-login-gate").count()).toBe(0);
    expect(await loginGateMounted()).toBe(false);
    await captureProof(page, "05-credentialless-connecting-shimmer", [
      page.locator(".connect-splash .loading-skeleton__composer"),
    ]);

    await gateway.resolveDeferred("connect");
    await page.locator("openclaw-app-shell").waitFor();
    expect(await page.locator(".connect-splash").count()).toBe(0);
    expect(await loginGateMounted()).toBe(false);
  });

  it("redirects before setup detection without loading the discarded workspace", async () => {
    const page = await createPage();
    await page.emulateMedia({ colorScheme: "dark" });
    const workspaceModules = new Set([
      "/src/components/app-sidebar.ts",
      "/src/components/browser/browser-panel.ts",
      "/src/components/assistant-panel.ts",
      "/src/components/desktop/desktop-panel.ts",
      "/src/components/terminal/terminal-panel-registration.ts",
      "/src/pages/chat/chat-page.ts",
    ]);
    const requestedWorkspaceModules = new Set<string>();
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname;
      if (workspaceModules.has(pathname)) {
        requestedWorkspaceModules.add(pathname);
      }
    });
    const gateway = await installMockGateway(page, {
      agentModel: null,
      deferredMethods: ["openclaw.setup.detect"],
      featureMethods: [
        "browser.request",
        "desktop.observe",
        "openclaw.chat",
        "openclaw.setup.detect",
        "openclaw.setup.prepare.start",
        "terminal.open",
      ],
      terminalEnabled: true,
    });

    await page.goto(server.baseUrl);
    await page.waitForURL("**/settings/model-setup?firstRun=1");
    expect(new URL(page.url()).pathname).toBe("/settings/model-setup");
    await gateway.waitForRequest("openclaw.setup.detect");
    expect(await gateway.getRequests("openclaw.setup.detect")).toHaveLength(1);
    const loading = page.getByText("Checking this Gateway for available AI access…", {
      exact: true,
    });
    await loading.waitFor();
    const loadingSections = page.locator('.model-setup__loading[role="status"][aria-busy="true"]');
    await loadingSections.locator(".model-setup__loading-sections").waitFor();
    expect(await loadingSections.locator(".settings-section").count()).toBe(4);
    expect(await loadingSections.locator(".model-setup__loading-row").count()).toBe(5);
    expect(await loadingSections.locator("button, input, wa-dropdown").count()).toBe(0);
    await page.evaluate(() => document.fonts.ready);
    // Compare section layouts at rest, not the shell's translated entrance frame.
    await waitForControlUiProofSurface(page.locator(".shell"), [loadingSections]);
    const sectionTitles = [
      "Found on this Gateway",
      "Run a model locally",
      "Connect an AI provider",
      "Connect with an API key or token",
    ];
    const loadingSectionTops = await Promise.all(
      sectionTitles.map(
        async (name) =>
          (await page.locator(".model-setup__loading-sections h2").getByText(name).boundingBox())!
            .y,
      ),
    );
    expect(await page.locator(".connect-splash").count()).toBe(0);
    expect([...requestedWorkspaceModules]).toEqual([]);
    await captureProof(page, "06-first-run-routed-before-detection", [loadingSections]);
    await page.setViewportSize({ height: 844, width: 390 });
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      )
      .toBe(true);
    await captureProof(page, "06b-first-run-routed-before-detection-mobile", [loadingSections]);
    await page.setViewportSize(viewport);

    await gateway.resolveDeferred("openclaw.setup.detect", {
      candidates: [
        {
          kind: "claude-cli",
          brandId: "claude",
          label: "Claude Code",
          detail: "Installed, not signed in",
          modelRef: "claude-cli/claude-opus-5",
          recommended: false,
          credentials: false,
        },
      ],
      manualProviders: [{ id: "openai", brandId: "openai", label: "OpenAI" }],
      authOptions: [
        {
          id: "openai-oauth",
          brandId: "openai",
          label: "OpenAI",
          kind: "oauth",
          featured: true,
        },
      ],
      prepareOptions: [
        { id: "ollama", brandId: "ollama", label: "Ollama" },
        { id: "lmstudio", brandId: "lmstudio", label: "LM Studio" },
      ],
      setupComplete: false,
      workspace: "/tmp/openclaw-e2e",
    });
    await loading.waitFor({ state: "detached" });
    await page.getByRole("heading", { name: "Connect a verified AI model" }).waitFor();
    // Restoring desktop starts a grid-row transition after the responsive Lit update.
    await page.locator(".shell:not(.shell--mobile-nav)").waitFor();
    await waitForControlUiProofSurface(page.locator(".shell"), [
      page.getByRole("heading", { name: "Connect a verified AI model" }),
    ]);
    const readySectionTops = await Promise.all(
      sectionTitles.map(
        async (name) => (await page.getByRole("heading", { name }).boundingBox())!.y,
      ),
    );
    expect(
      Math.max(...readySectionTops.map((top, index) => Math.abs(top - loadingSectionTops[index]!))),
    ).toBeLessThanOrEqual(13);
    expect([...requestedWorkspaceModules]).toEqual([]);
    const setupHeading = page.getByRole("heading", { name: "Connect a verified AI model" });
    await captureProof(page, "07-first-run-model-setup-ready", [setupHeading]);
    await page.setViewportSize({ height: 844, width: 390 });
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      )
      .toBe(true);
    await captureProof(page, "07b-first-run-model-setup-ready-mobile", [setupHeading]);
  });

  it.each(["entrance", "ancestor entrance", "lazy content"] as const)(
    "captures recovery pixels after %s readiness despite perpetual descendant animation",
    async (pending) => {
      const page = await createPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      // The endpoint rejects every attempt, including automatic reconnects.
      await installMockGateway(page, {
        methodResponses: {
          connect: {
            __mockError: {
              code: "INVALID_REQUEST",
              message: "origin not allowed",
              details: { code: ConnectErrorDetailCodes.CONTROL_UI_ORIGIN_NOT_ALLOWED },
            },
          },
        },
      });
      await page.goto(server.baseUrl);
      const surface = page.locator(".login-gate__card");
      const recoveryTitle = page.locator(".login-gate__failure-title");
      const recovery = page.getByText("Browser origin not allowed", { exact: true });
      await waitForControlUiProofSurface(surface, [recovery]);

      await page.evaluate((pendingPresentation) => {
        const card = document.querySelector<HTMLElement>(".login-gate__card")!;
        const title = document.querySelector<HTMLElement>(".login-gate__failure-title")!;
        const activity = document.createElement("span");
        activity.dataset.proofActivity = "";
        activity.textContent = "•";
        card.append(activity);
        activity.animate([{ opacity: 0.4 }, { opacity: 1 }], {
          duration: 100,
          iterations: Infinity,
        });
        // Explicit scheduling perturbations widen the unsafe capture window;
        // they do not change the application's wait budgets or capture policy.
        if (pendingPresentation !== "lazy content") {
          card.style.animationName = "none";
          void getComputedStyle(card).animationName;
          card.style.animationDelay = "1s";
          card.style.animationFillMode = "backwards";
          card.style.animationName = "scale-in";
          return;
        }
        const text = title.textContent!;
        const height = title.getBoundingClientRect().height;
        const lazyHost = document.createElement("openclaw-proof-recovery-title");
        lazyHost.style.display = "block";
        lazyHost.style.minHeight = `${height}px`;
        // Keep Lit's marker and text nodes intact for reconnect-driven renders.
        for (const child of title.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) {
            child.textContent = "";
          }
        }
        title.append(lazyHost);
        // A boxed lazy host is not meaningful content. An independent finite
        // descendant completes registration while the activity above stays live.
        const loading = lazyHost.animate([{ opacity: 1 }, { opacity: 1 }], { duration: 1_000 });
        void loading.finished.then(() => {
          customElements.define(
            "openclaw-proof-recovery-title",
            class extends HTMLElement {
              connectedCallback() {
                const label = document.createElement("span");
                label.textContent = text;
                this.replaceChildren(label);
              }
            },
          );
        });
      }, pending);

      const proof = await takeControlUiViewportScreenshot(
        page,
        pending === "ancestor entrance" ? recoveryTitle : surface,
        [recovery],
      );
      if (artifactDir) {
        await writeFile(
          path.join(artifactDir, `capture-readiness-${pending.replaceAll(" ", "-")}.png`),
          proof,
        );
      }
      // The crop contains recovery words, not the card border or animated dot.
      expect(
        await proofContentPainted(page, proof, recoveryTitle),
        "capture must paint recovery guidance",
      ).toBe(true);
      expect(
        await page
          .locator("[data-proof-activity]")
          .evaluate((element) => element.getAnimations()[0]?.playState),
      ).toBe("running");
      expect(await surface.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
      expect(pageErrors).toEqual([]);
    },
  );

  it("keeps finalized recording pixels intact while capturing an element on a tall page", async () => {
    const proofDir = createControlUiE2eArtifactDir("screenshot-video");
    const size = { width: 800, height: 600 };
    const context = await browser.newContext({
      viewport: size,
      recordVideo: { dir: proofDir, size },
    });
    openContexts.add(context);
    const page = await context.newPage();
    await page.setContent(`<!doctype html><style>
      body { margin: 0; height: 1800px; }
      #scene { position: fixed; inset: 0; background: conic-gradient(from 90deg,
        #2060e0 0 25%, #e04020 0 50%, #20c060 0 75%, #e0c020 0); }
      #row { position: absolute; left: 48px; top: 80px; width: 302px; height: 29px;
        background: linear-gradient(to right, #a030b0 50%, #20b0c0 50%); }
      #pulse { position: fixed; left: 400px; top: 300px; width: 20px; height: 20px;
        background: white; animation: pulse .1s infinite alternate; }
      @keyframes pulse { to { opacity: .2; } }
      </style><div id="scene"></div><div id="presentation"></div>`);
    await page.locator("#presentation").evaluate((host) => {
      // Capture consumers also select Web Awesome shadow parts. Their host's
      // presentation affects the pixels even though parentElement stops at the root.
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = '<div id="row"><div id="pulse"></div></div>';
      root.prepend(document.querySelector("style")!.cloneNode(true));
      // A delayed entrance can pass Playwright's consecutive-frame geometry check.
      host.animate(
        [
          { transform: "translateY(8px)", opacity: 0.4 },
          { transform: "none", opacity: 1 },
        ],
        {
          delay: 1_000,
          duration: 1_000,
          fill: "both",
        },
      );
    });
    const row = page.locator("#row");
    await row.waitFor();
    const activity = await page.locator("#pulse").evaluateHandle((element) => {
      const animation = element.getAnimations()[0]!;
      const interruptions: string[] = [];
      for (const type of ["cancel", "finish"]) {
        animation.addEventListener(type, () => interruptions.push(type));
      }
      return { animation, interruptions };
    });
    // Give the recorder a readable lead/tail; assertions below inspect every encoded frame.
    await page.waitForTimeout(300);
    const crop = await takeControlUiElementScreenshot(page, row, [row]);
    const presentationState = await page
      .locator("#presentation")
      .evaluate((element) => element.getAnimations()[0]?.playState);
    expect(
      await activity.evaluate(({ animation, interruptions }) => ({
        state: animation.playState,
        interruptions,
      })),
    ).toEqual({ state: "running", interruptions: [] });
    await activity.dispose();
    await writeFile(path.join(proofDir, "row.png"), crop);
    await writeFile(
      path.join(proofDir, "viewport.png"),
      await takeControlUiViewportScreenshot(page, row, [row]),
    );
    await page.waitForTimeout(300);
    const recording = page.video()!;
    await context.close();
    openContexts.delete(context);
    const videoBytes = await readFile(await recording.path());
    // Decode the finalized WebM in a separate, non-recording context. Seeking twice
    // per 25fps recorder frame catches short corruption without depending on host ffmpeg.
    const decoder = await createPageWithoutRecording();
    const frames = await decoder.evaluate(async (webm) => {
      const video = document.createElement("video");
      const loaded = new Promise<void>((resolve, reject) => {
        video.addEventListener("loadeddata", () => resolve(), { once: true });
        video.addEventListener(
          "error",
          () => reject(new Error(video.error?.message ?? "video decode failed")),
          { once: true },
        );
      });
      video.src = `data:video/webm;base64,${webm}`;
      await loaded;
      if (!Number.isFinite(video.duration) || video.duration <= 0) {
        throw new Error("invalid finalized video duration");
      }
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const painter = canvas.getContext("2d")!;
      const points = [
        [100, 200, 32, 192, 96],
        [700, 200, 224, 192, 32],
        [100, 500, 224, 64, 32],
        [700, 500, 32, 96, 224],
      ];
      let firstScene = -1;
      const corrupt: number[] = [];
      let evidence = "";
      let samples = 0;
      for (let time = 0.001; time < video.duration; time += 0.02) {
        const sought = new Promise<void>((resolve) => {
          video.addEventListener("seeked", () => resolve(), { once: true });
        });
        video.currentTime = time;
        await sought;
        painter.drawImage(video, 0, 0);
        const good = points.every(([x, y, ...rgb]) => {
          const pixel = painter.getImageData(x!, y!, 1, 1).data;
          return rgb.every((value, channel) => Math.abs(pixel[channel]! - value) < 20);
        });
        if (firstScene < 0 && good) {
          firstScene = time;
          evidence = canvas.toDataURL();
        }
        if (firstScene >= 0 && !good) {
          if (corrupt.length === 0) {
            evidence = canvas.toDataURL();
          }
          corrupt.push(time);
        }
        samples += 1;
      }
      return { firstScene, corrupt, samples, evidence };
    }, videoBytes.toString("base64"));
    await writeFile(
      path.join(proofDir, "decoded-frame.png"),
      Buffer.from(frames.evidence.split(",")[1]!, "base64"),
    );
    await writeFile(
      path.join(proofDir, "pixels.json"),
      JSON.stringify({ ...frames, evidence: undefined }, null, 2),
    );
    expect(
      frames.firstScene,
      "synthetic scene must appear in finalized recording",
    ).toBeGreaterThanOrEqual(0);
    expect(frames.samples).toBeGreaterThan(10);
    expect(
      frames.corrupt,
      "every frame after scene appearance must preserve viewport pixels",
    ).toEqual([]);
    expect(presentationState, "capture waits for the shadow host entrance").toBe("finished");
    const { data, ...info } = decodeProofPng(crop);
    expect([info.width, info.height]).toEqual([302, 29]);
    expect([...data.subarray(0, 3)]).toEqual([160, 48, 176]);
    expect([...data.subarray((info.width - 1) * 4, (info.width - 1) * 4 + 3)]).toEqual([
      32, 176, 192,
    ]);
  });

  it("waits for font pixels and final text bounds before cropping", async () => {
    const page = await createPageWithoutRecording();
    const fontUrl = `${server.baseUrl}fonts/jetbrains-mono-latin.woff2`;
    let releaseFont!: () => void;
    const fontReady = new Promise<void>((resolve) => {
      releaseFont = resolve;
    });
    await page.route(fontUrl, async (route) => {
      await fontReady;
      await route.fulfill({
        path: path.resolve("ui/public/fonts/jetbrains-mono-latin.woff2"),
        contentType: "font/woff2",
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    });
    await page.setContent(
      `<style>@font-face { font-family: proof; src: url("${fontUrl}"); }
      body { margin: 0; } #text { display: inline-block; margin: 40px;
        font: 40px proof, serif; background: #a030b0; color: white; }</style>
      <div id="text">iiiiiiiiiiii</div>`,
      { waitUntil: "domcontentloaded" },
    );
    const text = page.locator("#text");
    await expect.poll(() => page.evaluate(() => document.fonts.status)).toBe("loading");
    // A delayed font changes both glyph pixels and the inline element's width.
    // Release independently of capture so a missing font wait produces a bad PNG.
    const release = setTimeout(releaseFont, 1_000);
    let png: Buffer;
    try {
      png = await takeControlUiElementScreenshot(page, text, [text]);
    } finally {
      clearTimeout(release);
      releaseFont();
    }
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.fonts.check("40px proof"))).toBe(true);
    const bounds = (await text.boundingBox())!;
    const decoded = decodeProofPng(png);
    await writeFile(
      path.join(createControlUiE2eArtifactDir("screenshot-font"), "font-crop.png"),
      png,
    );
    expect(decoded.width).toBe(Math.ceil(bounds.x + bounds.width) - Math.floor(bounds.x));
    expect(decoded.height).toBe(Math.ceil(bounds.y + bounds.height) - Math.floor(bounds.y));
    expect(decoded.data.some((value, index) => index % 4 === 0 && value > 230)).toBe(true);
  });

  it("crops fractional bounds at high device scale and rejects elements outside the viewport", async () => {
    const context = await browser.newContext({
      viewport: { width: 800, height: 600 },
      deviceScaleFactor: 2,
    });
    openContexts.add(context);
    const page = await context.newPage();
    await page.setContent(`<!doctype html><style>body { margin: 0; height: 1800px; }
      #row { position: absolute; left: 48.25px; top: 940.25px; width: 302.5px; height: 29.5px; background: #a030b0; }
      #wide { width: 801px; height: 20px; } #tall { width: 20px; height: 601px; }
      </style><div id="row"></div><div id="wide"></div><div id="tall"></div>`);
    const row = page.locator("#row");
    const crop = await takeControlUiElementScreenshot(page, row, [row]);
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
    const viewportImage = decodeProofPng(await takeControlUiViewportScreenshot(page, row, [row]));
    for (const selector of ["#wide", "#tall"]) {
      const surface = page.locator(selector);
      await expect(takeControlUiElementScreenshot(page, surface, [surface])).rejects.toThrow(
        "not contained by the viewport",
      );
    }
    const { data, ...info } = decodeProofPng(crop);
    // Unclipped CDP uses the actual backing surface, not necessarily emulated DPR.
    expect([
      (info.width * 800) / viewportImage.width,
      (info.height * 600) / viewportImage.height,
    ]).toEqual([303, 30]);
    const center = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * 4;
    expect([...data.subarray(center, center + 3)]).toEqual([160, 48, 176]);
  });

  it("falls back to the login gate when stored credentials are rejected", async () => {
    const page = await createPage();
    const gateway = await installMockGateway(page, { deferredMethods: ["connect"] });

    await page.goto(`${server.baseUrl}#token=stale-token`);
    await gateway.waitForRequest("connect");
    await page.locator(".connect-splash").waitFor();

    await gateway.rejectDeferred("connect", {
      code: "UNAUTHORIZED",
      message: "unauthorized: gateway token mismatch",
      details: { code: ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH },
    });
    await page.locator("openclaw-login-gate").waitFor();
    expect(await page.locator(".connect-splash").count()).toBe(0);
  });

  it("keeps retryable Gateway startup on the progress splash", async () => {
    const page = await createPage();
    const loginGateMounted = await traceLoginGateMounts(page);
    const gateway = await installMockGateway(page, { deferredMethods: ["connect"] });

    await page.goto(`${server.baseUrl}#token=e2e-shared-token`);
    await gateway.waitForRequest("connect");
    const initialConnectCount = (await gateway.getRequests("connect")).length;
    await gateway.deferNext("connect");
    await gateway.rejectDeferred("connect", {
      code: "UNAVAILABLE",
      message: "gateway starting; retry shortly",
      details: { reason: "startup-sidecars" },
      retryable: true,
    });

    const splash = page.locator(".connect-splash");
    await splash.getByText("Gateway starting…", { exact: true }).waitFor();
    expect(await page.locator("openclaw-login-gate").count()).toBe(0);
    expect(await loginGateMounted()).toBe(false);
    await expect
      .poll(async () => await splash.evaluate((element) => getComputedStyle(element).opacity))
      .toBe("1");
    await captureProof(page, "06-gateway-starting-progress", [
      splash.locator(".loading-skeleton__composer"),
    ]);

    await expect
      .poll(async () => (await gateway.getRequests("connect")).length)
      .toBeGreaterThan(initialConnectCount);
    await gateway.resolveDeferred("connect");
    await page.locator("openclaw-app-shell").waitFor();
  });

  it("uses the splash for a stored device token on reload", async () => {
    const page = await createPage();
    const gateway = await installMockGateway(page, { deferredMethods: ["connect"] });

    // First visit has no credentials, but the Gateway still owns the pending attempt.
    await page.goto(server.baseUrl);
    await gateway.waitForRequest("connect");
    await page.locator(".connect-splash").waitFor();
    await gateway.resolveDeferred("connect");
    await page.locator("openclaw-app-shell").waitFor();

    // The hello stored a device token, so the reload connect is authenticated
    // and must paint the splash instead of flashing the gate.
    await page.reload();
    await gateway.waitForRequest("connect");
    await page.locator(".connect-splash").waitFor();
    expect(await page.locator("openclaw-login-gate").count()).toBe(0);

    await gateway.resolveDeferred("connect");
    await page.locator("openclaw-app-shell").waitFor();
  });
});
