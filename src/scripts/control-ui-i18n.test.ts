import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PI_PACKAGE_VERSION,
  findPlaceholderMismatches,
  isProviderAuthError,
  resolveLocalPiCommand,
} from "../../scripts/control-ui-i18n.ts";

describe("control-ui-i18n placeholder validation", () => {
  it("reports missing and extra placeholders by key", () => {
    const mismatches = findPlaceholderMismatches(
      new Map([
        ["sessionsView.activeTooltip", "Updated in the last {count} minutes."],
        ["sessionsView.store", "Store: {path}"],
        ["sessionsView.limitTooltip", "Max sessions to load."],
      ]),
      new Map([
        ["sessionsView.activeTooltip", "Actualizadas en los últimos N minutos."],
        ["sessionsView.store", "Almacén: {path}"],
        ["sessionsView.limitTooltip", "Máximo {extra} de sesiones."],
      ]),
      "es",
    );

    expect(mismatches).toEqual([
      {
        key: "sessionsView.activeTooltip",
        locale: "es",
        sourcePlaceholders: ["count"],
        translatedPlaceholders: [],
      },
      {
        key: "sessionsView.limitTooltip",
        locale: "es",
        sourcePlaceholders: [],
        translatedPlaceholders: ["extra"],
      },
    ]);
  });
});

describe("control-ui-i18n pi runtime resolution", () => {
  it("keeps the fallback pi package version aligned with the workspace dependency", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      dependencies?: Record<string, string>;
    };

    expect(DEFAULT_PI_PACKAGE_VERSION).toBe(
      packageJson.dependencies?.["@earendil-works/pi-coding-agent"],
    );
  });

  it("uses the workspace pi runtime before falling back to npm installation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "openclaw-control-ui-i18n-"));
    try {
      const cliPath = path.join(
        root,
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
        "dist",
        "cli.js",
      );
      await mkdir(path.dirname(cliPath), { recursive: true });
      await writeFile(cliPath, "#!/usr/bin/env node\n", "utf8");

      expect(resolveLocalPiCommand(root)).toEqual({
        executable: "node",
        args: [cliPath],
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("control-ui-i18n provider auth errors", () => {
  it("recognizes OpenAI and Anthropic authentication failures", () => {
    expect(isProviderAuthError(new Error("401 Incorrect API key provided"))).toBe(true);
    expect(
      isProviderAuthError(
        new Error(
          '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
        ),
      ),
    ).toBe(true);
    expect(isProviderAuthError(new Error("model timed out"))).toBe(false);
  });
});
