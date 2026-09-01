import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect } from "vitest";

export const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

type AvatarFixture = {
  id: string;
  background: string;
  label: string;
};

export async function routeAvatarFixtures(page: Page, fixtures: readonly AvatarFixture[]) {
  await Promise.all(
    fixtures.map(({ id, background, label }) =>
      page.route(`**/api/users/${id}/avatar*`, (route) =>
        route.fulfill({
          // Static input assets must not depend on browser screenshot availability.
          body: `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" fill="${background}"/><text x="32" y="32" text-anchor="middle" dominant-baseline="central" fill="white" style="font:700 26px system-ui">${label}</text></svg>`,
          contentType: "image/svg+xml",
          status: 200,
        }),
      ),
    ),
  );
}

export async function avatarLabelCenterDelta(row: Locator) {
  return row.evaluate((element) => {
    const avatar = element.querySelector<HTMLElement>("openclaw-session-owner-chip");
    const label = element.querySelector<HTMLElement>(".session-menu__text");
    if (!avatar || !label) {
      throw new Error("expected a complete owner filter row");
    }
    const avatarBounds = avatar.getBoundingClientRect();
    const labelBounds = label.getBoundingClientRect();
    return Math.abs(
      avatarBounds.top + avatarBounds.height / 2 - (labelBounds.top + labelBounds.height / 2),
    );
  });
}

export async function captureUiProof(
  owner: { readonly artifactDir: string },
  page: Page,
  fileName: string,
) {
  if (!captureUiProofEnabled) {
    return;
  }
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(owner.artifactDir, "drafts-ux", fileName),
  });
}

export async function captureSessionOwnerProof(
  owner: { readonly artifactDir: string },
  page: Page,
  fileName: string,
) {
  if (!captureUiProofEnabled) {
    return;
  }
  await page.locator(".sidebar-sessions").screenshot({
    animations: "disabled",
    path: path.join(owner.artifactDir, "session-owner-stack", fileName),
  });
}

export async function captureSessionOwnerPageProof(
  owner: { readonly artifactDir: string },
  page: Page,
  fileName: string,
) {
  if (!captureUiProofEnabled) {
    return;
  }
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(owner.artifactDir, "session-owner-stack", fileName),
  });
}

export async function openSidebarSortMenu(page: Page) {
  const filterAndSort = page.getByRole("button", { name: "Filter & sort" });
  await expect.poll(() => filterAndSort.count(), { timeout: 2_000 }).toBe(1);
  await filterAndSort.click();
  const menu = page.locator(".sidebar-session-sort-menu");
  await menu.waitFor();
  return menu;
}
