// Guards config entrypoints against unnecessary cold imports.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("config cold imports", () => {
  it("preserves runtime exports without loading type-only config modules", async () => {
    const typeOnlyModuleImport = vi.fn();
    vi.doMock("./types.channels.js", () => {
      typeOnlyModuleImport();
      return {};
    });

    try {
      const runtime = await importFreshModule<typeof import("./types.js")>(
        import.meta.url,
        "./types.js?scope=config-runtime-exports",
      );
      expect(typeOnlyModuleImport).not.toHaveBeenCalled();

      const [models, secrets, tools] = await Promise.all([
        import("./types.models.js"),
        import("./types.secrets.js"),
        import("./types.tools.js"),
      ]);
      expect(runtime).toMatchObject({ ...models, ...secrets, ...tools });
    } finally {
      vi.doUnmock("./types.channels.js");
    }
  });

  it("keeps validation command-alias guidance on manifest metadata", () => {
    const source = fs.readFileSync(path.join(repoRoot, "src/config/validation.ts"), "utf8");

    expect(source).not.toMatch(/\bfrom\s+["'][^"']*manifest-command-aliases\.runtime\.js["']/);
    expect(source).not.toMatch(/\bfrom\s+["'][^"']*providers\.runtime\.js["']/);
    expect(source).not.toMatch(/\bfrom\s+["'][^"']*loader\.js["']/);
    expect(source).not.toMatch(/\bfrom\s+["'][^"']*channels\/ids\.js["']/);
  });
});
