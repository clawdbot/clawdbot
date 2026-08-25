import type { BrowserContext, Locator, Page } from "playwright";

type AvatarFixture = {
  id: string;
  background: string;
  label: string;
};

async function createAvatarPng(context: BrowserContext, background: string, label: string) {
  const avatarPage = await context.newPage();
  try {
    await avatarPage.setViewportSize({ width: 64, height: 64 });
    await avatarPage.setContent(
      `<body style="margin:0;width:64px;height:64px;display:grid;place-items:center;background:${background};color:white;font:700 26px system-ui">${label}</body>`,
    );
    return await avatarPage.screenshot({ animations: "disabled", type: "png" });
  } finally {
    await avatarPage.close().catch(() => {});
  }
}

export async function routeAvatarFixtures(
  context: BrowserContext,
  page: Page,
  fixtures: readonly AvatarFixture[],
) {
  await Promise.all(
    fixtures.map(async ({ id, background, label }) => {
      const body = await createAvatarPng(context, background, label);
      await page.route(`**/api/users/${id}/avatar*`, (route) =>
        route.fulfill({ body, contentType: "image/png", status: 200 }),
      );
    }),
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
