/**
 * Browser CLI state commands for cookies, storage, viewport, emulation, and
 * HTTP context settings.
 */
import type { Command } from "commander";
import { parseStrictFiniteNumber } from "openclaw/plugin-sdk/number-runtime";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { parseBrowserViewportDimension, runBrowserResizeWithOutput } from "./browser-cli-resize.js";
import {
  BROWSER_TAB_REFERENCE_HELP,
  callBrowserRequest,
  printBrowserJsonResult,
  runBrowserCliCommand as runBrowserCommand,
  type BrowserParentOpts,
} from "./browser-cli-shared.js";
import { registerBrowserCookiesAndStorageCommands } from "./browser-cli-state.cookies-storage.js";
import { danger, defaultRuntime, parseBooleanValue } from "./core-api.js";

function parseOnOff(raw: string): boolean | null {
  const parsed = parseBooleanValue(raw);
  return parsed === undefined ? null : parsed;
}

function parseFiniteNumberOption(value: string | undefined, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = parseStrictFiniteNumber(value);
  if (parsed === undefined) {
    defaultRuntime.error(danger(`Invalid ${label}: must be a finite number`));
    defaultRuntime.exit(1);
    return undefined;
  }
  return parsed;
}

async function runBrowserSetRequest(params: {
  parent: BrowserParentOpts;
  path: string;
  body: Record<string, unknown>;
  successMessage: string;
}) {
  await runBrowserCommand(async () => {
    const profile = params.parent?.browserProfile;
    const result = await callBrowserRequest(params.parent, {
      method: "POST",
      path: params.path,
      query: profile ? { profile } : undefined,
      body: params.body,
    });
    if (printBrowserJsonResult(params.parent, result)) {
      return;
    }
    defaultRuntime.log(params.successMessage);
  });
}

/** Registers Browser state/configuration commands. */
export function registerBrowserStateCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  registerBrowserCookiesAndStorageCommands(browser, parentOpts);

  const set = browser.command("set").description("Browser environment settings");

  set
    .command("viewport")
    .description("Set viewport size (alias for resize)")
    .argument("<width>", "Viewport width")
    .argument("<height>", "Viewport height")
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .action(async (widthRaw: string, heightRaw: string, opts, cmd) => {
      const width = parseBrowserViewportDimension(widthRaw, "width");
      const height = parseBrowserViewportDimension(heightRaw, "height");
      if (width === undefined || height === undefined) {
        return;
      }
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      await runBrowserCommand(async () => {
        await runBrowserResizeWithOutput({
          parent,
          profile,
          width,
          height,
          targetId: opts.targetId,
          successMessage: `viewport set: ${width}x${height}`,
        });
      });
    });

  set
    .command("offline")
    .description("Toggle offline mode")
    .argument("<on|off>", "on/off")
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .action(async (value: string, opts, cmd) => {
      const parent = parentOpts(cmd);
      const offline = parseOnOff(value);
      if (offline === null) {
        defaultRuntime.error(danger("Expected on|off"));
        defaultRuntime.exit(1);
        return;
      }
      await runBrowserSetRequest({
        parent,
        path: "/set/offline",
        body: {
          offline,
          targetId: normalizeOptionalString(opts.targetId),
        },
        successMessage: `offline: ${offline}`,
      });
    });

  set
    .command("headers")
    .description("Set extra HTTP headers (JSON object)")
    .argument("[headersJson]", "JSON object of headers (alternative to --headers-json)")
    .option("--headers-json <json>", "JSON object of headers")
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .action(async (headersJson: string | undefined, opts, cmd) => {
      const parent = parentOpts(cmd);
      await runBrowserCommand(async () => {
        const headersJsonValue =
          normalizeOptionalString(opts.headersJson) ?? normalizeOptionalString(headersJson);
        if (!headersJsonValue) {
          throw new Error("Missing headers JSON (pass --headers-json or positional JSON argument)");
        }
        const parsed = JSON.parse(headersJsonValue) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Headers JSON must be a JSON object");
        }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === "string") {
            headers[k] = v;
          }
        }
        const profile = parent?.browserProfile;
        const result = await callBrowserRequest(parent, {
          method: "POST",
          path: "/set/headers",
          query: profile ? { profile } : undefined,
          body: {
            headers,
            targetId: normalizeOptionalString(opts.targetId),
          },
        });
        if (printBrowserJsonResult(parent, result)) {
          return;
        }
        defaultRuntime.log("headers set");
      });
    });

  set
    .command("credentials")
    .description("Set HTTP basic auth credentials")
    .option("--clear", "Clear credentials", false)
    .argument("[username]", "Username")
    .argument("[password]", "Password")
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .action(async (username: string | undefined, password: string | undefined, opts, cmd) => {
      const parent = parentOpts(cmd);
      await runBrowserSetRequest({
        parent,
        path: "/set/credentials",
        body: {
          username: normalizeOptionalString(username),
          password,
          clear: Boolean(opts.clear),
          targetId: normalizeOptionalString(opts.targetId),
        },
        successMessage: opts.clear ? "credentials cleared" : "credentials set",
      });
    });

  set
    .command("geo")
    .description("Set geolocation (and grant permission)")
    .option("--clear", "Clear geolocation + permissions", false)
    .argument("[latitude]", "Latitude")
    .argument("[longitude]", "Longitude")
    .option("--accuracy <m>", "Accuracy in meters")
    .option("--origin <origin>", "Origin to grant permissions for")
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .action(
      async (latitudeRaw: string | undefined, longitudeRaw: string | undefined, opts, cmd) => {
        const parent = parentOpts(cmd);
        const latitude = parseFiniteNumberOption(latitudeRaw, "latitude");
        const longitude = parseFiniteNumberOption(longitudeRaw, "longitude");
        const accuracy = parseFiniteNumberOption(opts.accuracy, "--accuracy");
        if (
          (latitudeRaw !== undefined && latitude === undefined) ||
          (longitudeRaw !== undefined && longitude === undefined) ||
          (opts.accuracy !== undefined && accuracy === undefined)
        ) {
          return;
        }
        await runBrowserSetRequest({
          parent,
          path: "/set/geolocation",
          body: {
            latitude,
            longitude,
            accuracy,
            origin: normalizeOptionalString(opts.origin),
            clear: Boolean(opts.clear),
            targetId: normalizeOptionalString(opts.targetId),
          },
          successMessage: opts.clear ? "geolocation cleared" : "geolocation set",
        });
      },
    );

  set
    .command("media")
    .description("Emulate prefers-color-scheme")
    .argument("<dark|light|no-preference|none>", "dark/light/no-preference/none")
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .action(async (value: string, opts, cmd) => {
      const parent = parentOpts(cmd);
      const v = normalizeOptionalLowercaseString(value);
      const colorScheme =
        v === "dark" || v === "light" || v === "no-preference" || v === "none" ? v : null;
      if (!colorScheme) {
        defaultRuntime.error(danger("Expected dark|light|no-preference|none"));
        defaultRuntime.exit(1);
        return;
      }
      await runBrowserSetRequest({
        parent,
        path: "/set/media",
        body: {
          colorScheme,
          targetId: normalizeOptionalString(opts.targetId),
        },
        successMessage: `media colorScheme: ${colorScheme}`,
      });
    });

  set
    .command("timezone")
    .description("Override timezone (CDP)")
    .argument("<timezoneId>", "Timezone ID (e.g. America/New_York)")
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .action(async (timezoneId: string, opts, cmd) => {
      const parent = parentOpts(cmd);
      await runBrowserSetRequest({
        parent,
        path: "/set/timezone",
        body: {
          timezoneId,
          targetId: normalizeOptionalString(opts.targetId),
        },
        successMessage: `timezone: ${timezoneId}`,
      });
    });

  set
    .command("locale")
    .description("Override locale (CDP)")
    .argument("<locale>", "Locale (e.g. en-US)")
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .action(async (locale: string, opts, cmd) => {
      const parent = parentOpts(cmd);
      await runBrowserSetRequest({
        parent,
        path: "/set/locale",
        body: {
          locale,
          targetId: normalizeOptionalString(opts.targetId),
        },
        successMessage: `locale: ${locale}`,
      });
    });

  set
    .command("device")
    .description('Apply a Playwright device descriptor (e.g. "iPhone 14")')
    .argument("<name>", "Device name (Playwright devices)")
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .action(async (name: string, opts, cmd) => {
      const parent = parentOpts(cmd);
      await runBrowserSetRequest({
        parent,
        path: "/set/device",
        body: {
          name,
          targetId: normalizeOptionalString(opts.targetId),
        },
        successMessage: `device: ${name}`,
      });
    });
}
