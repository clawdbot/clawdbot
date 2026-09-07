import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("Gmail setup diagnostics through real command execution", () => {
  it.each(["login", "watch"])(
    "propagates a bounded %s failure without writing config",
    async (failure) => {
      await withOpenClawTestState(
        { label: "gmail-diagnostics", scenario: "minimal" },
        async (state) => {
          const binDir = state.path("bin");
          const tracePath = state.path("commands.log");
          await fs.mkdir(binDir);
          for (const bin of ["gcloud", "gog"]) {
            const script = [
              `#!${process.execPath}`,
              'const fs = require("node:fs");',
              "const args = process.argv.slice(2);",
              `const bin = ${JSON.stringify(bin)};`,
              `fs.appendFileSync(${JSON.stringify(tracePath)}, bin + " " + args.slice(0, 3).join(" ") + "\\n");`,
              `const failing = ${JSON.stringify(failure)};`,
              'if (bin === "gcloud" && args[0] === "auth" && args[1] === "list") {',
              '  if (failing === "login") process.exit(1);',
              '  fs.writeSync(1, "fixture@example.com\\n"); process.exit(0);',
              "}",
              'if ((bin === "gcloud" && args[1] === "login") || bin === "gog") {',
              '  fs.writeSync(1, "x".repeat(30000) + "\\r\\nstdout final detail 🦞\\r\\n");',
              '  fs.writeSync(2, Array.from({length: 1000}, (_, i) => "progress " + i).join("\\r") + "\\r\\n\\u001b[31mstderr final detail\\u001b[0m\\r\\n");',
              "  process.exit(7);",
              "}",
              "process.exit(0);",
            ].join("\n");
            await fs.writeFile(state.path("bin", bin), script, { mode: 0o755 });
          }
          await withEnvAsync(
            {
              PATH: binDir,
              XDG_CONFIG_HOME: state.path("xdg"),
              CLOUDSDK_CONFIG: state.path("gcloud-config"),
              CLOUDSDK_PYTHON: undefined,
              CLOUDSDK_PYTHON_ARGS: undefined,
            },
            async () => {
              vi.resetModules();
              const { runGmailSetup } = await import("./gmail-ops.js");
              const configBefore = await fs.readFile(state.configPath, "utf8");
              let message = "";
              try {
                await runGmailSetup({
                  account: "fixture@example.com",
                  project: "fixture-project",
                  tailscale: "off",
                  pushEndpoint: "https://example.com/push?token=fixture-only",
                  hookToken: "fixture-hook",
                  pushToken: "fixture-push",
                });
              } catch (error) {
                if (!(error instanceof Error)) {
                  throw error;
                }
                message = error.message;
              }
              const commands = (await fs.readFile(tracePath, "utf8")).trim().split("\n");
              expect(commands[0]).toBe("gcloud auth list --filter");
              expect(commands.at(-1)).toBe(
                failure === "login" ? "gcloud auth login" : "gog gmail watch start",
              );
              expect(await fs.readFile(state.configPath, "utf8")).toBe(configBefore);
              console.info(
                `fixture ${failure}: ${commands.length} commands; error chars=${message.length}; stdout tail=${message.includes("stdout final detail")}; stderr tail=${message.includes("stderr final detail")}; exit metadata=${message.includes("code=7")}`,
              );
              expect(message.length).toBeLessThan(2000);
              expect(message).toContain(
                failure === "login" ? "gcloud auth login failed" : "gog gmail watch start failed",
              );
              expect(message).toContain("code=7");
              expect(message).toContain("stdout final detail 🦞");
              expect(message).toContain("stderr final detail");
              expect(message).not.toContain("\r");
              expect(message).not.toContain(String.fromCharCode(27));
              expect(message).not.toContain("fixture-only");
              console.info(`fixture ${failure} diagnostic: ${message.split("\n")[0]}`);
            },
          );
        },
      );
    },
  );
});
