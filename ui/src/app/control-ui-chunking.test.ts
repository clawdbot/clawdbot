// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  controlUiBootManifestKey,
  controlUiCodeSplitting,
  controlUiStableChunkName,
} from "../../config/control-ui-chunking.ts";

describe("Control UI build chunking", () => {
  it("groups stable runtime dependencies into bounded chunks", () => {
    expect(controlUiStableChunkName("/repo/ui/node_modules/lit/index.js")).toBe("lit-runtime");
    expect(controlUiStableChunkName("/repo/ui/node_modules/lit-html/directives/repeat.js")).toBe(
      "lit-runtime",
    );
    expect(controlUiStableChunkName("/repo/ui/node_modules/highlight.js/lib/core.js")).toBe(
      "markdown-runtime",
    );
    expect(
      controlUiStableChunkName("/tmp/openclaw-pnpm-node-modules/dompurify/dist/purify.es.mjs"),
    ).toBe("markdown-runtime");
    expect(controlUiStableChunkName("/tmp/openclaw-pnpm-node-modules/zod/v4/core/schemas.js")).toBe(
      "config-runtime",
    );
    expect(controlUiStableChunkName("/tmp/openclaw-pnpm-node-modules/json5/dist/index.js")).toBe(
      "config-runtime",
    );
    expect(
      controlUiStableChunkName(
        "/tmp/openclaw-pnpm-node-modules/libphonenumber-js/max/exports/parsePhoneNumber.js",
      ),
    ).toBe("config-runtime");
    expect(
      controlUiStableChunkName("/repo/ui/src/components/config-form.shared.ts"),
    ).toBeUndefined();
    expect(controlUiStableChunkName("/repo/ui/src/lib/clipboard.ts")).toBeUndefined();
    expect(controlUiStableChunkName("/repo/ui/src/build-info.ts")).toBeUndefined();
    expect(controlUiStableChunkName("/repo/ui/src/build-info-normalizers.ts")).toBeUndefined();
    expect(
      controlUiStableChunkName("/tmp/openclaw-pnpm-node-modules/@noble/ed25519/index.js"),
    ).toBe("gateway-runtime");
    expect(controlUiStableChunkName("/repo/ui/src/lib/gateway-methods.ts")).toBe("gateway-runtime");
    expect(controlUiStableChunkName("/repo/ui/src/app/app-host.ts")).toBeUndefined();
  });

  it("bounds only the initial module graph without recursively absorbing dependencies", () => {
    expect(controlUiCodeSplitting.includeDependenciesRecursively).toBe(false);
    expect(controlUiCodeSplitting.groups[1]).toMatchObject({
      tags: ["$initial"],
      maxSize: 640 * 1024,
    });
  });

  it("consolidates the measured boot module set with recursive dependencies", () => {
    // Recursive inclusion is a correctness requirement for this group: merging
    // the lazy boot graph without it emitted chunks whose execution order broke
    // at application start.
    expect(controlUiCodeSplitting.groups[2]).toMatchObject({
      name: "control-ui-boot",
      includeDependenciesRecursively: true,
    });
    const bootGroup = controlUiCodeSplitting.groups[2] as {
      test: (id: string) => boolean;
    };
    const repoRoot = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
    // Representative always-loaded boot surface and a lazy island that must
    // keep its own chunk (terminal runtime is not part of the default boot).
    expect(bootGroup.test(`${repoRoot}/ui/src/components/app-sidebar.ts`)).toBe(true);
    expect(bootGroup.test(`${repoRoot}/node_modules/ghostty-web/dist/index.js`)).toBe(false);
  });

  it("derives stable manifest keys across pnpm layouts and platforms", () => {
    expect(
      controlUiBootManifestKey(
        "/repo/node_modules/.pnpm/nanoid@5.0.0/node_modules/nanoid/index.browser.js",
      ),
    ).toBe("node_modules/nanoid/index.browser.js");
    expect(
      controlUiBootManifestKey(
        "/repo/node_modules/@awesome.me/webawesome/node_modules/nanoid/index.browser.js",
      ),
    ).toBe("node_modules/nanoid/index.browser.js");
    expect(controlUiBootManifestKey("/repo/ui/src/main.ts?html-proxy&index=0.js")).not.toContain(
      "?",
    );
    expect(controlUiBootManifestKey(String.raw`C:\repo\node_modules\nanoid\index.browser.js`)).toBe(
      "node_modules/nanoid/index.browser.js",
    );
  });

  it("normalizes Windows module paths before package matching", () => {
    expect(
      controlUiStableChunkName(String.raw`C:\repo\ui\node_modules\highlight.js\lib\core.js`),
    ).toBe("markdown-runtime");
  });
});
