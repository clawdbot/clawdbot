import type { Command } from "commander";

import { danger } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import { parseBooleanValue } from "../utils/boolean.js";
import { callBrowserRequest, type BrowserParentOpts } from "./browser-cli-shared.js";
import { registerBrowserCookiesAndStorageCommands } from "./browser-cli-state.cookies-storage.js";
import { runCommandWithRuntime } from "./cli-utils.js";

function parseOnOff(raw: string): boolean | null {
  const parsed = parseBooleanValue(raw);
  return parsed === undefined ? null : parsed;
}

function runBrowserCommand(action: () => Promise<void>) {
  return runCommandWithRuntime(defaultRuntime, action, (err) => {
    defaultRuntime.error(danger(String(err)));
    defaultRuntime.exit(1);
  });
}

export function registerBrowserStateCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  registerBrowserCookiesAndStorageCommands(browser, parentOpts);

  const set = browser.command("set").description("Browser environment settings");

  set
    .command("viewport")
    .description("Set viewport size (alias for resize)")
    .argument("<width>", "Viewport width", (v: string) => Number(v))
    .argument("<height>", "Viewport height", (v: string) => Number(v))
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (width: number, height: number, opts, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      if (!Number.isFinite(width) || !Number.isFinite(height)) {
        defaultRuntime.error(danger("width and height must be numbers"));
        defaultRuntime.exit(1);
        return;
      }
      await runBrowserCommand(async () => {
        const result = await callBrowserRequest(
          parent,
          {
            method: "POST",
            path: "/act",
            query: profile ? { profile } : undefined,
            body: {
              kind: "resize",
              width,
              height,
              targetId: opts.targetId?.trim() || undefined,
            },
          },
          { timeoutMs: 20000 },
        );
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(`viewport set: ${width}x${height}`);
      });
    });

  set
    .command("offline")
    .description("Toggle offline mode")
    .argument("<on|off>", "on/off")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (value: string, opts, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      const offline = parseOnOff(value);
      if (offline === null) {
        defaultRuntime.error(danger("Expected on|off"));
        defaultRuntime.exit(1);
        return;
      }
      await runBrowserCommand(async () => {
        const result = await callBrowserRequest(
          parent,
          {
            method: "POST",
            path: "/set/offline",
            query: profile ? { profile } : undefined,
            body: {
              offline,
              targetId: opts.targetId?.trim() || undefined,
            },
          },
          { timeoutMs: 20000 },
        );
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(`offline: ${offline}`);
      });
    });

  set
    .command("headers")
    .description("Set extra HTTP headers (JSON object)")
    .requiredOption("--json <json>", "JSON object of headers")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (opts, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      await runBrowserCommand(async () => {
        const parsed = JSON.parse(String(opts.json)) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("headers json must be an object");
        }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === "string") headers[k] = v;
        }
        const result = await callBrowserRequest(
          parent,
          {
            method: "POST",
            path: "/set/headers",
            query: profile ? { profile } : undefined,
            body: {
              headers,
              targetId: opts.targetId?.trim() || undefined,
            },
          },
          { timeoutMs: 20000 },
        );
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
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
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (username: string | undefined, password: string | undefined, opts, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      await runBrowserCommand(async () => {
        const result = await callBrowserRequest(
          parent,
          {
            method: "POST",
            path: "/set/credentials",
            query: profile ? { profile } : undefined,
            body: {
              username: username?.trim() || undefined,
              password,
              clear: Boolean(opts.clear),
              targetId: opts.targetId?.trim() || undefined,
            },
          },
          { timeoutMs: 20000 },
        );
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(opts.clear ? "credentials cleared" : "credentials set");
      });
    });

  set
    .command("geo")
    .description("Set geolocation (and grant permission)")
    .option("--clear", "Clear geolocation + permissions", false)
    .argument("[latitude]", "Latitude", (v: string) => Number(v))
    .argument("[longitude]", "Longitude", (v: string) => Number(v))
    .option("--accuracy <m>", "Accuracy in meters", (v: string) => Number(v))
    .option("--origin <origin>", "Origin to grant permissions for")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (latitude: number | undefined, longitude: number | undefined, opts, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      await runBrowserCommand(async () => {
        const result = await callBrowserRequest(
          parent,
          {
            method: "POST",
            path: "/set/geolocation",
            query: profile ? { profile } : undefined,
            body: {
              latitude: Number.isFinite(latitude) ? latitude : undefined,
              longitude: Number.isFinite(longitude) ? longitude : undefined,
              accuracy: Number.isFinite(opts.accuracy) ? opts.accuracy : undefined,
              origin: opts.origin?.trim() || undefined,
              clear: Boolean(opts.clear),
              targetId: opts.targetId?.trim() || undefined,
            },
          },
          { timeoutMs: 20000 },
        );
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(opts.clear ? "geolocation cleared" : "geolocation set");
      });
    });

  set
    .command("media")
    .description("Emulate prefers-color-scheme")
    .argument("<dark|light|none>", "dark/light/none")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (value: string, opts, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      const v = value.trim().toLowerCase();
      const colorScheme =
        v === "dark" ? "dark" : v === "light" ? "light" : v === "none" ? "none" : null;
      if (!colorScheme) {
        defaultRuntime.error(danger("Expected dark|light|none"));
        defaultRuntime.exit(1);
        return;
      }
      await runBrowserCommand(async () => {
        const result = await callBrowserRequest(
          parent,
          {
            method: "POST",
            path: "/set/media",
            query: profile ? { profile } : undefined,
            body: {
              colorScheme,
              targetId: opts.targetId?.trim() || undefined,
            },
          },
          { timeoutMs: 20000 },
        );
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(`media colorScheme: ${colorScheme}`);
      });
    });

  set
    .command("timezone")
    .description("Override timezone (CDP)")
    .argument("<timezoneId>", "Timezone ID (e.g. America/New_York)")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (timezoneId: string, opts, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      await runBrowserCommand(async () => {
        const result = await callBrowserRequest(
          parent,
          {
            method: "POST",
            path: "/set/timezone",
            query: profile ? { profile } : undefined,
            body: {
              timezoneId,
              targetId: opts.targetId?.trim() || undefined,
            },
          },
          { timeoutMs: 20000 },
        );
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(`timezone: ${timezoneId}`);
      });
    });

  set
    .command("locale")
    .description("Override locale (CDP)")
    .argument("<locale>", "Locale (e.g. en-US)")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (locale: string, opts, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      await runBrowserCommand(async () => {
        const result = await callBrowserRequest(
          parent,
          {
            method: "POST",
            path: "/set/locale",
            query: profile ? { profile } : undefined,
            body: {
              locale,
              targetId: opts.targetId?.trim() || undefined,
            },
          },
          { timeoutMs: 20000 },
        );
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(`locale: ${locale}`);
      });
    });

  set
    .command("device")
    .description('Apply a Playwright device descriptor (e.g. "iPhone 14")')
    .argument("<name>", "Device name (Playwright devices)")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (name: string, opts, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      await runBrowserCommand(async () => {
        const result = await callBrowserRequest(
          parent,
          {
            method: "POST",
            path: "/set/device",
            query: profile ? { profile } : undefined,
            body: {
              name,
              targetId: opts.targetId?.trim() || undefined,
            },
          },
          { timeoutMs: 20000 },
        );
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(`device: ${name}`);
      });
    });
}
