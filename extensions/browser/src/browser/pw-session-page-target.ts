import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CDPSession, Page } from "playwright-core";
import { PLAYWRIGHT_TARGET_INFO_TIMEOUT_MS } from "./cdp-timeouts.js";

type PageTargetInfo = { targetId: string; title: string };

// A Page owns one bounded target-info read at a time so concurrent enumerations share its
// temporary CDP session. Settled reads evict themselves so later calls observe fresh metadata.
const targetInfoReads = new WeakMap<Page, Promise<PageTargetInfo | null>>();

async function readPageTargetInfo(page: Page): Promise<PageTargetInfo | null> {
  let session: CDPSession | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let detachStarted = false;
  const detach = () => {
    if (!session || detachStarted) {
      return;
    }
    detachStarted = true;
    void session.detach().catch(() => {});
  };
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      detach();
      resolve(null);
    }, PLAYWRIGHT_TARGET_INFO_TIMEOUT_MS);
    timer.unref?.();
  });
  const read = (async () => {
    session = await page.context().newCDPSession(page);
    if (timedOut) {
      detach();
      return null;
    }
    try {
      const { targetInfo } = await session.send("Target.getTargetInfo");
      const targetId = normalizeOptionalString(targetInfo.targetId) ?? "";
      if (!targetId) {
        return null;
      }
      return { targetId, title: targetInfo.title };
    } finally {
      detach();
    }
  })();
  try {
    return await Promise.race([read, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export function pageTargetInfo(page: Page): Promise<PageTargetInfo | null> {
  const existing = targetInfoReads.get(page);
  if (existing) {
    return existing;
  }
  const pending = readPageTargetInfo(page);
  targetInfoReads.set(page, pending);
  const evict = () => {
    if (targetInfoReads.get(page) === pending) {
      targetInfoReads.delete(page);
    }
  };
  void pending.then(evict, evict);
  return pending;
}
