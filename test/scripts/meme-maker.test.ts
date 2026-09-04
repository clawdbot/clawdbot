import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createSolidPngBuffer } from "../helpers/image-fixtures.js";
import { createScriptTestHarness } from "./test-helpers.js";

const execFileAsync = promisify(execFile);
const { createTempDir } = createScriptTestHarness();
const skillRoot = path.resolve("skills/meme-maker");
const scriptPath = path.join(skillRoot, "scripts/meme.mjs");
const template = JSON.parse(
  fs.readFileSync(path.join(skillRoot, "references/templates.json"), "utf8"),
).find((entry: { id: string }) => entry.id === "always-has-been") as {
  id: string;
  imgflipId: string;
  width: number;
  height: number;
};

function renderFixture(format: "svg" | "png", isolated = false) {
  const root = createTempDir("openclaw-meme-maker-");
  const cache = path.join(root, "cache");
  const imageDir = path.join(cache, "openclaw/meme-maker");
  fs.mkdirSync(imageDir, { recursive: true });
  const image = createSolidPngBuffer(32, 24, { r: 24, g: 160, b: 96 });
  fs.writeFileSync(path.join(imageDir, `${template.id}-${template.imgflipId}.png`), image);
  const hook = path.join(root, "offline.mjs");
  fs.writeFileSync(
    hook,
    `import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "sharp") throw new Error("Sharp is unavailable");
  return nextResolve(specifier, context);
} });
globalThis.fetch = () => { throw new Error("Unexpected network access"); };
`,
  );
  let script = scriptPath;
  if (isolated) {
    fs.cpSync(skillRoot, path.join(root, "skill"), { recursive: true });
    script = path.join(root, "skill/scripts/meme.mjs");
  }
  const out = path.join(root, `meme.${format}`);
  const result = execFileAsync(
    process.execPath,
    ["--import", hook, script, "render", template.id, "--text", "Fish & chips", "--out", out],
    { env: { ...process.env, XDG_CACHE_HOME: cache }, timeout: 30_000 },
  );
  return { image, out, result };
}

describe("meme-maker local rendering", () => {
  it("writes a self-contained SVG with escaped text without optional rendering dependencies", async () => {
    const { image, out, result } = renderFixture("svg", true);
    const { stdout } = await result;
    const svg = fs.readFileSync(out, "utf8");
    expect(stdout).toContain(out);
    expect(svg).toContain(`width="${template.width}" height="${template.height}"`);
    expect(svg).toContain(`data:image/png;base64,${image.toString("base64")}`);
    expect(svg).toContain("Fish &amp; chips");
  });

  it("directs SVG output when PNG rendering is unavailable without inviting package installs", async () => {
    const { out, result } = renderFixture("png", true);
    await expect(result).rejects.toMatchObject({
      stderr: "error: PNG output needs Chromium or Chrome. Use --out meme.svg instead.\n",
    });
    expect(fs.existsSync(out)).toBe(false);
  });

  it.runIf(process.env.OPENCLAW_LIVE_TEST === "1")(
    "renders a PNG at the template dimensions without Sharp",
    async () => {
      const { out, result } = renderFixture("png");
      const { stdout } = await result;
      const png = fs.readFileSync(out);
      expect(stdout).toContain(out);
      expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      const { default: photon } = await import("@silvia-odwyer/photon-node");
      const rendered = photon.PhotonImage.new_from_byteslice(png);
      try {
        expect([rendered.get_width(), rendered.get_height()]).toEqual([
          template.width,
          template.height,
        ]);
        const pixels = rendered.get_raw_pixels();
        expect([...pixels.subarray(0, 4)]).toEqual([24, 160, 96, 255]);
        // The cached background is solid green; black and white pixels prove text was painted.
        expect(pixels.some((value, index) => index % 4 === 0 && value === 0)).toBe(true);
        expect(pixels.some((value, index) => index % 4 === 0 && value === 255)).toBe(true);
      } finally {
        rendered.free();
      }
    },
  );
});
