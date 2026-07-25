// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
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
    expect(controlUiStableChunkName("/repo/ui/src/components/config-form.shared.ts")).toBe(
      "control-ui-shared",
    );
    expect(controlUiStableChunkName("/repo/ui/src/lib/clipboard.ts")).toBe("control-ui-shared");
    expect(controlUiStableChunkName("/repo/ui/src/build-info.ts")).toBe("control-ui-shared");
    expect(controlUiStableChunkName("/repo/ui/src/build-info-normalizers.ts")).toBe(
      "control-ui-shared",
    );
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
      maxSize: 512 * 1024,
    });
  });

  it("normalizes Windows module paths before package matching", () => {
    expect(
      controlUiStableChunkName(String.raw`C:\repo\ui\node_modules\highlight.js\lib\core.js`),
    ).toBe("markdown-runtime");
  });
});
