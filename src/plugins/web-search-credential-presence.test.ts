// Verifies web-search credential presence checks for plugins.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

let hasConfiguredWebSearchCredential: typeof import("./web-search-credential-presence.js").hasConfiguredWebSearchCredential;

function googleModelCredentialConfig(plugins?: OpenClawConfig["plugins"]): OpenClawConfig {
  return {
    models: {
      providers: {
        google: {
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          apiKey: "google-model-key",
          models: [],
        },
      },
    },
    ...(plugins ? { plugins } : {}),
  };
}

beforeAll(async () => {
  ({ hasConfiguredWebSearchCredential } = await import("./web-search-credential-presence.js"));
});

describe("hasConfiguredWebSearchCredential", () => {
  it("does not statically import web-search runtime providers", () => {
    const source = fs.readFileSync(
      path.join(repoRoot, "src/plugins/web-search-credential-presence.ts"),
      "utf8",
    );

    expect(source).not.toMatch(/\bfrom\s+["'][^"']*web-search-providers\.runtime\.js["']/);
    expect(source).not.toMatch(/\bfrom\s+["'][^"']*loader\.js["']/);
  });

  it("keeps empty config and env on the manifest-only path", () => {
    expect(
      hasConfiguredWebSearchCredential({
        config: {} as OpenClawConfig,
        env: {},
        origin: "bundled",
      }),
    ).toBe(false);
  });

  it("detects configured web search credential candidates without runtime loading", () => {
    expect(
      hasConfiguredWebSearchCredential({
        config: {
          tools: { web: { search: { apiKey: "brave-key" } } },
        } as OpenClawConfig,
        env: {},
        origin: "bundled",
      }),
    ).toBe(true);
  });

  it("detects manifest-declared model credential fallbacks without provider-specific core logic", () => {
    expect(
      hasConfiguredWebSearchCredential({
        config: googleModelCredentialConfig(),
        env: {},
        origin: "bundled",
      }),
    ).toBe(true);
  });

  it.each([
    {
      name: "an explicitly disabled plugin",
      plugins: { entries: { google: { enabled: false } } },
    },
    {
      name: "a denylisted plugin",
      plugins: { deny: ["google"] },
    },
    {
      name: "a plugin outside a restrictive allowlist",
      plugins: { allow: ["another-plugin"] },
    },
  ])("does not accept manifest credentials from $name", ({ plugins }) => {
    expect(
      hasConfiguredWebSearchCredential({
        config: googleModelCredentialConfig(plugins),
        env: {},
        origin: "bundled",
      }),
    ).toBe(false);
  });
});
