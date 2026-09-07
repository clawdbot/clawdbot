import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "playwright";
import { expect } from "vitest";
import type { ApplicationRuntime } from "../app/bootstrap.ts";

export async function verifyGatewayServedControlUiBundle(httpUrl: string): Promise<{
  assetPath: string;
  assetSha256: string;
}> {
  const distRoot = path.resolve("dist/control-ui");
  const builtIndex = await readFile(path.join(distRoot, "index.html"), "utf8");
  const assetPath = builtIndex.match(/<script[^>]+src="\.\/(assets\/[^"]+\.js)"/u)?.[1];
  if (!assetPath) {
    throw new Error("built Control UI index has no JavaScript asset path");
  }
  const servedIndexResponse = await fetch(httpUrl);
  expect(servedIndexResponse.status).toBe(200);
  expect(await servedIndexResponse.text()).toContain(`src="/${assetPath}"`);
  const servedAssetResponse = await fetch(new URL(assetPath, httpUrl));
  expect(servedAssetResponse.status).toBe(200);
  const servedAsset = Buffer.from(await servedAssetResponse.arrayBuffer());
  const builtAsset = await readFile(path.join(distRoot, assetPath));
  const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
  const assetSha256 = hash(builtAsset);
  expect(hash(servedAsset)).toBe(assetSha256);
  return { assetPath, assetSha256 };
}

export async function captureConfigReadbackFailure(page: Page): Promise<void> {
  const deadline = new AbortController();
  try {
    // Capture fixed name/connection facts, never label text or auth/config state.
    // The separate deadline must not hide the original click failure.
    const snapshot = await Promise.race([
      Promise.all([
        page.evaluate(() => {
          const app = document.querySelector<HTMLElement & { runtime?: ApplicationRuntime }>(
            "openclaw-app",
          );
          const phase = app?.runtime?.context.gateway.snapshot.phase;
          const phases = [
            "stopped",
            "connecting",
            "starting",
            "connected",
            "reconnecting",
            "reload-required",
            "offline",
          ];
          return {
            pathname: location.pathname.slice(0, 160),
            navigationAgeMs: Math.round(performance.now()),
            gatewayPhase: phases.includes(phase ?? "") ? phase : "unknown",
            mainInert: document.querySelector("main")?.inert ?? null,
            outletInert:
              document.querySelector<HTMLElement>("openclaw-router-outlet")?.inert ?? null,
            rawButtons: [
              ...document.querySelectorAll<HTMLButtonElement>(".config-mode-toggle button"),
            ]
              .filter((button) => button.textContent?.trim() === "Raw")
              .slice(0, 3)
              .map((button) => ({
                disabled: button.disabled,
                hasLayout: button.getClientRects().length > 0,
                inertAncestor: button.closest("[inert]") !== null,
                label: !button.hasAttribute("aria-label")
                  ? "absent"
                  : button.getAttribute("aria-label") === "Raw"
                    ? "raw"
                    : "other",
                labelledBy: button.hasAttribute("aria-labelledby"),
              })),
          };
        }),
        page.getByRole("button", { name: "Raw", exact: true }).count(),
        page.getByRole("button", { name: "Raw", exact: true, includeHidden: true }).count(),
      ])
        .then(([state, roleMatches, roleMatchesIncludingHidden]) => ({
          ...state,
          roleMatches,
          roleMatchesIncludingHidden,
        }))
        .catch(() => "unavailable"),
      delay(1_000, "timed-out", { signal: deadline.signal }),
    ]);
    console.error(`[real-config-readback-failure] ${JSON.stringify(snapshot)}`);
  } finally {
    deadline.abort();
  }
}
