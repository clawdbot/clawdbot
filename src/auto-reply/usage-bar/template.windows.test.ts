import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { resolveResponseUsageLine } from "../reply/agent-runner-usage-line.js";
import { clearUsageBarTemplateCacheForTest } from "./template.test-support.js";

const homeState = vi.hoisted(() => ({ home: undefined as string | undefined }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => homeState.home ?? actual.homedir(),
  };
});

describe.runIf(process.platform === "win32")("usage footer Windows home paths", () => {
  afterEach(() => {
    clearUsageBarTemplateCacheForTest();
    homeState.home = undefined;
  });

  it("renders a custom footer loaded through a backslash home prefix", async () => {
    await withTestDir({ prefix: "openclaw-usage-footer-home-" }, async (home) => {
      homeState.home = home;
      const fileName = "usage café footer.json";
      await fs.writeFile(
        path.join(home, fileName),
        JSON.stringify({ segments: [{ text: "WINDOWS CUSTOM FOOTER" }] }),
      );

      const rendered = resolveResponseUsageLine({
        config: {
          messages: {
            responseUsage: "full",
            usageTemplate: `~\\${fileName}`,
          },
        } as OpenClawConfig,
        sessionRaw: "full",
        usage: { input: 12, output: 3 },
        provider: "fixture",
        model: "fixture-model",
        replyUsageState: {
          provider: "fixture",
          model: "fixture-model",
          usage: { input: 12, output: 3 },
        },
      });

      expect(rendered).toBe("WINDOWS CUSTOM FOOTER");
    });
  });
});
