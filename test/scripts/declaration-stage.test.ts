import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publishStagedDeclarations } from "../../scripts/lib/declaration-stage.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());
function fixture() {
  const root = fs.realpathSync(roots.make("declaration-stage-"));
  const staging = path.join(root, "staging");
  const dist = path.join(root, "dist");
  function write(base: string, file: string, text: string) {
    const target = path.join(base, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  write(dist, "plugin-sdk/obsolete.d.ts", "old");
  write(dist, "core.d.ts", "core");
  write(dist, "shared-old.d.ts", "unattributed");
  write(dist, "runtime.js", "runtime");
  const invocation = (files: Record<string, string>, exitCode = 0) => ({
    command: process.execPath,
    args: [
      "-e",
      `const fs=require('node:fs'),path=require('node:path'); for(const [file,bytes] of Object.entries(${JSON.stringify(files)})){const p=path.join(${JSON.stringify(staging)},file);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,bytes);} process.exitCode=${exitCode};`,
    ],
    options: { stdio: ["ignore", "pipe", "pipe"], shell: false, env: process.env },
  });
  return { staging, dist, invocation };
}

describe("canonical declaration stage", () => {
  it("rejects absolute reference paths even when a staged relative namesake exists", async () => {
    const { staging, dist, invocation } = fixture();
    await expect(
      publishStagedDeclarations(
        {
          env: process.env,
          maxOldSpaceMb: 8192,
          heapShortfall: null,
          invocations: [
            invocation({
              "plugin-sdk/core.d.ts": '/// <reference path="/shared.d.ts" />\nexport {};',
              "plugin-sdk/shared.d.ts": "export {};",
            }),
          ],
        },
        staging,
        dist,
        ["plugin-sdk/core.d.ts"],
      ),
    ).rejects.toThrow("Incomplete declaration closure");
    expect(fs.readFileSync(path.join(dist, "plugin-sdk/obsolete.d.ts"), "utf8")).toBe("old");
  });
  it.each([
    '/// <reference path="./missing.d.ts" />\nexport {};',
    'import Type = require("./missing.cjs"); export { Type };',
    'export * as Types from "./missing.js";',
    'export type Type = import("./missing.js").Type;',
  ])("rejects a missing relative dependency in %s", async (declaration) => {
    const { staging, dist, invocation } = fixture();
    await expect(
      publishStagedDeclarations(
        {
          env: process.env,
          maxOldSpaceMb: 8192,
          heapShortfall: null,
          invocations: [invocation({ "plugin-sdk/core.d.ts": declaration })],
        },
        staging,
        dist,
        ["plugin-sdk/core.d.ts"],
      ),
    ).rejects.toThrow("Incomplete declaration closure");
    expect(fs.readFileSync(path.join(dist, "plugin-sdk/obsolete.d.ts"), "utf8")).toBe("old");
  });

  it("ignores imports in comments while preserving an actual reference directive", async () => {
    const { staging, dist, invocation } = fixture();
    const files = {
      "plugin-sdk/core.d.ts":
        '/// <reference path="../shared.d.ts" />\n// import type {Absent} from "./not-an-import.js";\nexport {};',
      "shared.d.ts": "export {};",
    };
    await publishStagedDeclarations(
      {
        env: process.env,
        maxOldSpaceMb: 8192,
        heapShortfall: null,
        invocations: [invocation(files)],
      },
      staging,
      dist,
      ["plugin-sdk/core.d.ts"],
    );
    expect(fs.readFileSync(path.join(dist, "plugin-sdk/core.d.ts"), "utf8")).toBe(
      files["plugin-sdk/core.d.ts"],
    );
  });
  it.skipIf(process.platform === "win32")(
    "does not mask a timeout when the child exits zero on SIGTERM",
    async () => {
      const { staging, dist, invocation } = fixture();
      vi.stubEnv("OPENCLAW_TSDOWN_TIMEOUT_MS", "1500");
      vi.stubEnv("OPENCLAW_TSDOWN_HEARTBEAT_MS", "0");
      const first = invocation({});
      first.args = [
        "-e",
        `const fs=require('node:fs');process.on('SIGTERM',()=>process.exit(0));fs.mkdirSync(${JSON.stringify(staging)},{recursive:true});fs.writeFileSync(${JSON.stringify(path.join(staging, "ready"))},'ready');setInterval(()=>{},1000);`,
      ];
      await expect(
        publishStagedDeclarations(
          {
            env: process.env,
            maxOldSpaceMb: 8192,
            heapShortfall: null,
            invocations: [first, invocation({ "later.d.ts": "export {};" })],
          },
          staging,
          dist,
          [],
        ),
      ).rejects.toMatchObject({ exitCode: 124 });
      expect(fs.existsSync(path.join(staging, "ready"))).toBe(true);
      expect(fs.existsSync(path.join(staging, "later.d.ts"))).toBe(false);
      expect(fs.readFileSync(path.join(dist, "plugin-sdk/obsolete.d.ts"), "utf8")).toBe("old");
    },
  );
  it.each(["child failure", "missing entry", "missing nested chunk"])(
    "does not publish on %s",
    async (failure) => {
      const { staging, dist, invocation } = fixture();
      const plan = {
        env: process.env,
        maxOldSpaceMb: 8192,
        heapShortfall: null,
        invocations: [
          invocation({ "plugin-sdk/public.d.ts": 'export type { Shared } from "../shared.js";' }),
          invocation(
            failure === "missing nested chunk"
              ? { "plugin-sdk/private.d.ts": "export {};" }
              : { "shared.d.ts": "export type Shared = string;" },
            failure === "child failure" ? 2 : 0,
          ),
        ],
      };
      const before = fs.readdirSync(dist, { recursive: true }).map(String).toSorted();
      await expect(
        publishStagedDeclarations(plan, staging, dist, [
          "plugin-sdk/public.d.ts",
          "plugin-sdk/private.d.ts",
        ]),
      ).rejects.toThrow();
      expect(fs.readdirSync(dist, { recursive: true }).map(String).toSorted()).toEqual(before);
      expect(fs.readFileSync(path.join(dist, "plugin-sdk/obsolete.d.ts"), "utf8")).toBe("old");
    },
  );

  it("publishes both groups with root chunks, preserves unrelated files, and prunes only owned entries", async () => {
    const { staging, dist, invocation } = fixture();
    const publicFile = {
      "plugin-sdk/public.d.ts": 'export type { Shared } from "../shared.js";',
      "shared.d.ts": 'export type Shared = import("./z-leaf.js").Leaf;',
      "z-leaf.d.ts": "export type Leaf = string;",
    };
    const plan = {
      env: process.env,
      maxOldSpaceMb: 8192,
      heapShortfall: null,
      invocations: [
        invocation(publicFile),
        invocation({ "plugin-sdk/private.d.ts": 'export type { Shared } from "../shared.js";' }),
      ],
    };
    const rename = fs.renameSync;
    const observed: string[] = [];
    const publication = vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
      if (
        target === path.join(dist, "plugin-sdk/public.d.ts") ||
        target === path.join(dist, "plugin-sdk/private.d.ts")
      ) {
        observed.push(
          fs.existsSync(path.join(dist, "shared.d.ts")) ? "dependency ready" : "missing dependency",
        );
      }
      if (target === path.join(dist, "shared.d.ts")) {
        observed.push(
          fs.existsSync(path.join(dist, "z-leaf.d.ts")) ? "leaf ready" : "missing leaf",
        );
      }
      rename(source, target);
    });
    try {
      await publishStagedDeclarations(plan, staging, dist, [
        "plugin-sdk/public.d.ts",
        "plugin-sdk/private.d.ts",
      ]);
    } finally {
      publication.mockRestore();
    }
    expect(observed).toEqual(["leaf ready", "dependency ready", "dependency ready"]);
    expect(fs.existsSync(path.join(dist, "plugin-sdk/obsolete.d.ts"))).toBe(false);
    for (const [file, bytes] of Object.entries({
      ...publicFile,
      "core.d.ts": "core",
      "shared-old.d.ts": "unattributed",
      "runtime.js": "runtime",
    })) {
      expect(fs.readFileSync(path.join(dist, file), "utf8")).toBe(bytes);
    }
    const unchanged = fs.statSync(path.join(dist, "plugin-sdk/public.d.ts")).mtimeMs;
    fs.rmSync(staging, { recursive: true });
    await publishStagedDeclarations(
      { ...plan, invocations: [invocation(publicFile)] },
      staging,
      dist,
      ["plugin-sdk/public.d.ts"],
    );
    expect(fs.existsSync(path.join(dist, "plugin-sdk/private.d.ts"))).toBe(false);
    expect(fs.statSync(path.join(dist, "plugin-sdk/public.d.ts")).mtimeMs).toBe(unchanged);
  });
});
