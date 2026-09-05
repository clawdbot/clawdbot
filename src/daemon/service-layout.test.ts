import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { gatewayServiceCommandUsesRoot } from "../cli/update-cli/update-command-service-plan.js";
import { summarizeGatewayServiceLayout } from "./service-layout.js";

describe("summarizeGatewayServiceLayout", () => {
  it("resolves a relative entrypoint against an absolute working directory", async () => {
    expect(
      (
        await summarizeGatewayServiceLayout({
          programArguments: ["node", "dist/index.js", "gateway", "run"],
          workingDirectory: "/repo/openclaw",
        })
      )?.entrypoint,
    ).toBe(path.join("/repo/openclaw", "dist", "index.js"));
  });

  it("resolves Windows service entrypoints with Windows path semantics", async () => {
    expect(
      (
        await summarizeGatewayServiceLayout({
          programArguments: ["node.exe", "dist\\index.js", "gateway", "run"],
          workingDirectory: "C:\\openclaw",
        })
      )?.entrypoint,
    ).toBe("C:\\openclaw\\dist\\index.js");
  });

  it("rejects a relative entrypoint without an absolute service working directory", async () => {
    await expect(
      summarizeGatewayServiceLayout({
        programArguments: ["node", "dist/index.js", "gateway", "run"],
      }),
    ).resolves.not.toHaveProperty("entrypoint");
    await expect(
      summarizeGatewayServiceLayout({
        programArguments: ["node", "dist/index.js", "gateway", "run"],
        workingDirectory: "./checkout",
      }),
    ).resolves.not.toHaveProperty("entrypoint");
  });
});

describe("gatewayServiceCommandUsesRoot release ownership", () => {
  it.each(["stable", "foreign", "pinned", "paired", "different-mount"] as const)(
    "checks the effective launcher against the managed installation (%s)",
    async (layout) => {
      const root = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-release-owner-")),
      );
      try {
        const managedRoot = path.join(root, "openclaw");
        const release = path.join(root, "releases", "selected");
        const foreign = path.join(root, "foreign", "releases", "selected");
        const current = path.join(root, "current");
        const mounted = layout === "paired" || layout === "different-mount";
        for (const packageRoot of [managedRoot, release, foreign, ...(mounted ? [current] : [])]) {
          await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
          await fs.writeFile(path.join(packageRoot, "package.json"), '{"name":"openclaw"}');
          await fs.writeFile(path.join(packageRoot, "dist", "index.js"), "gateway");
        }
        if (!mounted) {
          await fs.symlink(layout === "foreign" ? foreign : release, current);
        } else if (layout === "paired") {
          // The Docker proof supplies real bind mounts; this isolates directory identity.
          const selected = await fs.stat(release);
          const stat = fs.stat.bind(fs);
          vi.spyOn(fs, "stat").mockImplementation(async (target) =>
            path.resolve(String(target)) === current ? selected : stat(target),
          );
        }
        const command = {
          programArguments: [
            process.execPath,
            path.join(layout === "pinned" ? release : current, "dist", "index.js"),
            "gateway",
          ],
          managedDefinition: {
            programArguments: [
              process.execPath,
              path.join(managedRoot, "dist", "index.js"),
              "gateway",
            ],
          },
        };
        await expect(gatewayServiceCommandUsesRoot({ root: managedRoot, command })).resolves.toBe(
          layout === "stable" || layout === "paired",
        );
        await expect(
          gatewayServiceCommandUsesRoot({ root: managedRoot, command: command.managedDefinition }),
        ).resolves.toBe(true);
      } finally {
        vi.restoreAllMocks();
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});
