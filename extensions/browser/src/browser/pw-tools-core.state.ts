/**
 * Browser context and emulation state helpers for Playwright-backed tools.
 */
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { Page } from "playwright-core";
import { playwrightCore } from "./playwright-core.runtime.js";
import { ensurePageState, getPageForTargetId } from "./pw-session.js";
import { withPageScopedCdpClient } from "./pw-session.page-cdp.js";

const { devices: playwrightDevices } = playwrightCore;
const deviceTransitionTails = new WeakMap<Page, Promise<void>>();

type DeviceSize = { width: number; height: number };

type PlaywrightDeviceDescriptor = {
  userAgent: string;
  viewport: DeviceSize;
  screen?: DeviceSize;
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
};

async function runDeviceTransition(params: {
  page: Page;
  signal?: AbortSignal;
  run: () => Promise<void>;
}): Promise<void> {
  params.signal?.throwIfAborted();
  const previous = deviceTransitionTails.get(params.page) ?? Promise.resolve();
  const transition = previous
    .catch(() => {})
    .then(async () => {
      params.signal?.throwIfAborted();
      // Once admitted, finish the whole descriptor. Aborting between overrides would
      // leave viewport, user agent, metrics, and touch state from different devices.
      await params.run();
    });
  const tail = transition.catch(() => {});
  deviceTransitionTails.set(params.page, tail);
  try {
    await transition;
  } finally {
    if (deviceTransitionTails.get(params.page) === tail) {
      deviceTransitionTails.delete(params.page);
    }
  }
}

/** Toggles offline mode for the target page context. */
export async function setOfflineViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  offline: boolean;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  await page.context().setOffline(opts.offline);
}

/** Replaces extra HTTP headers for the target page context. */
export async function setExtraHTTPHeadersViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  headers: Record<string, string>;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  await page.context().setExtraHTTPHeaders(opts.headers);
}

/** Sets or clears HTTP basic-auth credentials for the target page context. */
export async function setHttpCredentialsViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  username?: string;
  password?: string;
  clear?: boolean;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  if (opts.clear) {
    await page.context().setHTTPCredentials(null);
    return;
  }
  const username = opts.username ?? "";
  const password = opts.password ?? "";
  if (!username) {
    throw new Error("username is required (or set clear=true)");
  }
  await page.context().setHTTPCredentials({ username, password });
}

/** Sets or clears geolocation and grants page-origin geolocation permission. */
export async function setGeolocationViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  origin?: string;
  clear?: boolean;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  const context = page.context();
  if (opts.clear) {
    await context.setGeolocation(null);
    await context.clearPermissions().catch(() => {});
    return;
  }
  if (typeof opts.latitude !== "number" || typeof opts.longitude !== "number") {
    throw new Error("latitude and longitude are required (or set clear=true)");
  }
  await context.setGeolocation({
    latitude: opts.latitude,
    longitude: opts.longitude,
    accuracy: typeof opts.accuracy === "number" ? opts.accuracy : undefined,
  });
  const origin =
    normalizeOptionalString(opts.origin) ||
    (() => {
      try {
        return new URL(page.url()).origin;
      } catch {
        return "";
      }
    })();
  if (origin) {
    await context.grantPermissions(["geolocation"], { origin }).catch(() => {});
  }
}

/** Emulates the requested media color scheme on the target page. */
export async function emulateMediaViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  colorScheme: "dark" | "light" | "no-preference" | null;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  await page.emulateMedia({ colorScheme: opts.colorScheme });
}

/** Applies a locale override through page-scoped CDP. */
export async function setLocaleViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  locale: string;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  const locale = normalizeOptionalString(opts.locale) ?? "";
  if (!locale) {
    throw new Error("locale is required");
  }
  await withPageScopedCdpClient({
    cdpUrl: opts.cdpUrl,
    page,
    targetId: opts.targetId,
    fn: async (send) => {
      try {
        await send("Emulation.setLocaleOverride", { locale });
      } catch (err) {
        if (String(err).includes("Another locale override is already in effect")) {
          return;
        }
        throw err;
      }
    },
  });
}

/** Applies a timezone override through page-scoped CDP. */
export async function setTimezoneViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  timezoneId: string;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  const timezoneId = normalizeOptionalString(opts.timezoneId) ?? "";
  if (!timezoneId) {
    throw new Error("timezoneId is required");
  }
  await withPageScopedCdpClient({
    cdpUrl: opts.cdpUrl,
    page,
    targetId: opts.targetId,
    fn: async (send) => {
      try {
        await send("Emulation.setTimezoneOverride", { timezoneId });
      } catch (err) {
        const msg = String(err);
        if (msg.includes("Timezone override is already in effect")) {
          return;
        }
        if (msg.includes("Invalid timezone")) {
          throw new Error(`Invalid timezone ID: ${timezoneId}`, { cause: err });
        }
        throw err;
      }
    },
  });
}

/** Applies a Playwright device descriptor to viewport, user agent, and touch state. */
export async function setDeviceViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  name: string;
  signal?: AbortSignal;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  const name = normalizeOptionalString(opts.name) ?? "";
  if (!name) {
    throw new Error("device name is required");
  }
  const descriptor = (playwrightDevices as Record<string, unknown>)[name] as
    | PlaywrightDeviceDescriptor
    | undefined;
  if (!descriptor) {
    throw new Error(`Unknown device "${name}".`);
  }

  await runDeviceTransition({
    page,
    signal: opts.signal,
    run: async () => {
      const screen = descriptor.screen ?? descriptor.viewport;
      const isLandscape = screen.width > screen.height;

      // Keep Playwright's page model aligned before applying the descriptor fields
      // that its public setViewportSize API cannot express on an attached context.
      await page.setViewportSize({
        width: descriptor.viewport.width,
        height: descriptor.viewport.height,
      });

      await withPageScopedCdpClient({
        cdpUrl: opts.cdpUrl,
        page,
        targetId: opts.targetId,
        fn: async (send) => {
          await send("Emulation.setUserAgentOverride", {
            userAgent: descriptor.userAgent,
          });
          await send("Emulation.setDeviceMetricsOverride", {
            mobile: descriptor.isMobile,
            width: descriptor.viewport.width,
            height: descriptor.viewport.height,
            deviceScaleFactor: descriptor.deviceScaleFactor,
            screenWidth: screen.width,
            screenHeight: screen.height,
            screenOrientation:
              descriptor.isMobile && !isLandscape
                ? { angle: 0, type: "portraitPrimary" }
                : { angle: descriptor.isMobile ? 90 : 0, type: "landscapePrimary" },
          });
          await send("Emulation.setTouchEmulationEnabled", {
            enabled: descriptor.hasTouch,
          });
        },
      });
    },
  });
}
