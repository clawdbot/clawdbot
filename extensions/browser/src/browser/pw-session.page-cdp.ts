import type { CDPSession, Page } from "playwright-core";

type PageCdpSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

async function withPlaywrightPageCdpSession<T>(
  page: Page,
  fn: (session: CDPSession) => Promise<T>,
): Promise<T> {
  const session = await page.context().newCDPSession(page);
  try {
    return await fn(session);
  } finally {
    await session.detach().catch(() => {});
  }
}

export async function withPageScopedCdpClient<T>(opts: {
  cdpUrl: string;
  page: Page;
  targetId?: string;
  fn: (send: PageCdpSend) => Promise<T>;
}): Promise<T> {
  return await withPlaywrightPageCdpSession(opts.page, async (session) => {
    return await opts.fn((method, params) =>
      (
        session.send as unknown as (
          method: string,
          params?: Record<string, unknown>,
        ) => Promise<unknown>
      )(method, params),
    );
  });
}
