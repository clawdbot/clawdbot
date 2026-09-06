import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import { createPluginRecord } from "../plugins/loader-records.js";
import { createPluginRegistry } from "../plugins/registry.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";

const report = "Backup completed successfully.";

describe("plugin newline chunk delivery", () => {
  it.each([
    {
      name: "does not overflow a full report with its terminating blank line",
      text: `${report}\n\n`,
      limit: 30,
      transportLimit: 30,
      expected: [report],
    },
    {
      name: "preserves a terminating blank line that fits",
      text: `${report}\n\n`,
      limit: 32,
      transportLimit: 32,
      expected: [`${report}\n\n`],
    },
    {
      name: "bounds the last report after earlier lines were delivered",
      text: `${report}\n${report}\n\n`,
      limit: 31,
      transportLimit: 31,
      expected: [report, `${report}\n`],
    },
    {
      name: "preserves ordinary blank lines between reports",
      text: `${report}\n\n${report}`,
      limit: 32,
      transportLimit: 32,
      expected: [report, `\n${report}`],
    },
    {
      name: "preserves an unsplit long line without adding excess blank lines",
      text: `${report}\n\n`,
      limit: 10,
      transportLimit: 30,
      options: { splitLongLines: false },
      expected: [report],
    },
    {
      name: "keeps an indivisible astral character without adding blank lines",
      text: "😀\n\n",
      limit: 1,
      transportLimit: 2,
      expected: ["😀"],
    },
    {
      name: "reserves a complete astral character after leading blank lines",
      text: "\n😀",
      limit: 2,
      transportLimit: 2,
      expected: ["😀"],
    },
    {
      name: "reserves a complete astral character after interior blank lines",
      text: "ok\n\n😀",
      limit: 2,
      transportLimit: 2,
      expected: ["ok", "😀"],
    },
  ])("$name", ({ text, limit, transportLimit, options, expected }) => {
    const accepted: string[] = [];
    const plugin = definePluginEntry({
      id: "newline-report-test",
      name: "Newline report test",
      description: "Exercises the injected text helper from a plugin entry.",
      register(api) {
        for (const chunk of api.runtime.channel.text.chunkByNewline(text, limit, options)) {
          // This transport is intentionally bounded independently of the chunker.
          // The long-line opt-out and indivisible-code-point cases use wider transports.
          if (chunk.length > transportLimit) {
            throw new Error(
              `Transport rejected ${chunk.length} UTF-16 units; limit ${transportLimit}`,
            );
          }
          accepted.push(chunk);
        }
      },
    });
    const registry = createPluginRegistry({
      runtime: createPluginRuntime(),
      logger: { info() {}, warn() {}, error() {} },
      activateGlobalSideEffects: false,
    });
    const record = createPluginRecord({
      id: plugin.id,
      source: "/virtual/newline-report-test/index.ts",
      origin: "global",
      enabled: true,
      configSchema: true,
    });
    const api = registry.createApi(record, { config: {} });

    plugin.register(api);

    expect(accepted).toEqual(expected);
  });
});
