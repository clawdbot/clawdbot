import { describe, expect, it } from "vitest";
import { controlUiManualChunk } from "../../config/control-ui-chunking.ts";

describe("Control UI build chunking", () => {
  it("groups stable runtime dependencies into bounded chunks", () => {
    expect(controlUiManualChunk("/repo/ui/node_modules/lit/index.js")).toBe("lit-runtime");
    expect(controlUiManualChunk("/repo/ui/node_modules/lit-html/directives/repeat.js")).toBe(
      "lit-runtime",
    );
    expect(controlUiManualChunk("/repo/ui/node_modules/highlight.js/lib/core.js")).toBe(
      "markdown-runtime",
    );
    expect(
      controlUiManualChunk("/tmp/openclaw-pnpm-node-modules/dompurify/dist/purify.es.mjs"),
    ).toBe("markdown-runtime");
    expect(controlUiManualChunk("/tmp/openclaw-pnpm-node-modules/zod/v4/core/schemas.js")).toBe(
      "config-runtime",
    );
    expect(controlUiManualChunk("/tmp/openclaw-pnpm-node-modules/json5/dist/index.js")).toBe(
      "config-runtime",
    );
    expect(controlUiManualChunk("/repo/ui/src/components/config-form.shared.ts")).toBe(
      "control-ui-shared",
    );
    expect(controlUiManualChunk("/repo/ui/src/lib/clipboard.ts")).toBe("control-ui-shared");
    expect(controlUiManualChunk("/tmp/openclaw-pnpm-node-modules/@noble/ed25519/index.js")).toBe(
      "gateway-runtime",
    );
    expect(controlUiManualChunk("/repo/ui/src/app/app-host.ts")).toBeUndefined();
  });

  it("normalizes Windows module paths before package matching", () => {
    expect(controlUiManualChunk(String.raw`C:\repo\ui\node_modules\highlight.js\lib\core.js`)).toBe(
      "markdown-runtime",
    );
  });
});
