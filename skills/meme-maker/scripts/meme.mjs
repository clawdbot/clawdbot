#!/usr/bin/env node
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATES_PATH = path.join(BASE_DIR, "references", "templates.json");
const IMGFLIP_GET_MEMES_URL = "https://api.imgflip.com/get_memes";
const IMGFLIP_CAPTION_URL = "https://api.imgflip.com/caption_image";
const USER_AGENT = "OpenClawMemeMaker/1.0";
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "for",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "this",
  "to",
  "use",
  "with",
]);

function usage(exitCode = 0) {
  const out = exitCode === 0 ? console.log : console.error;
  out(`Usage:
  meme.mjs list [--json]
  meme.mjs search <query> [--json]
  meme.mjs suggest <topic> [--limit N] [--json]
  meme.mjs render <template> --text TEXT ... [--out PATH] [--service local|imgflip]
  meme.mjs refresh [--limit N] [--json]`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      flags._.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    if (["json", "help"].includes(key)) {
      flags[key] = true;
      continue;
    }
    const value = inline ?? argv[i + 1];
    if (inline === undefined) i += 1;
    if (value === undefined) throw new Error(`Missing value for --${key}`);
    if (key === "text") {
      flags.text = [...(flags.text ?? []), value];
    } else {
      flags[key] = value;
    }
  }
  return flags;
}

function normalize(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(value) {
  return normalize(value)
    .split(/\s+/)
    .filter((token) => token && !STOPWORDS.has(token));
}

async function loadTemplates() {
  return JSON.parse(await readFile(TEMPLATES_PATH, "utf8"));
}

function templateHaystack(template) {
  return [
    template.id,
    template.name,
    template.use,
    ...(template.aliases ?? []),
    ...(template.tags ?? []),
    ...(template.fields ?? []),
  ].join(" ");
}

function scoreTemplate(template, query) {
  const queryTokens = tokens(query);
  const haystack = normalize(templateHaystack(template));
  let score = 0;
  for (const token of queryTokens) {
    if (normalize(template.id).includes(token)) score += 8;
    if (normalize(template.name).includes(token)) score += 6;
    if ((template.aliases ?? []).some((alias) => normalize(alias).includes(token))) score += 5;
    if ((template.tags ?? []).some((tag) => normalize(tag).includes(token))) score += 4;
    if (normalize(template.use).includes(token)) score += 3;
    if (haystack.includes(token)) score += 1;
  }
  return score;
}

function findTemplate(templates, selector) {
  const wanted = normalize(selector);
  const exact = templates.find(
    (template) =>
      normalize(template.id) === wanted ||
      normalize(template.name) === wanted ||
      (template.aliases ?? []).some((alias) => normalize(alias) === wanted),
  );
  if (exact) return exact;
  const ranked = templates
    .map((template) => ({ template, score: scoreTemplate(template, selector) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.template;
}

function printTemplates(templates, json) {
  if (json) {
    console.log(JSON.stringify(templates, null, 2));
    return;
  }
  for (const template of templates) {
    console.log(`${template.id}: ${template.name}`);
    console.log(`  use: ${template.use}`);
    console.log(`  fields: ${template.fields.join(", ")}`);
    console.log(`  kym: ${template.kymUrl}`);
  }
}

function cacheRoot() {
  const root =
    process.env.XDG_CACHE_HOME ||
    (process.platform === "darwin"
      ? path.join(homedir(), "Library", "Caches")
      : path.join(homedir(), ".cache"));
  return path.join(root, "openclaw", "meme-maker");
}

function extFromUrl(url) {
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  return ext && ext.length <= 5 ? ext : ".img";
}

async function fetchBuffer(url) {
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) throw new Error(`Fetch failed ${response.status} for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function cachedTemplateImage(template) {
  const dir = cacheRoot();
  await mkdir(dir, { recursive: true });
  const file = path.join(
    dir,
    `${template.id}-${template.imgflipId}${extFromUrl(template.imageUrl)}`,
  );
  if (existsSync(file)) return { file, buffer: await readFile(file) };
  const buffer = await fetchBuffer(template.imageUrl);
  await writeFile(file, buffer);
  return { file, buffer };
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function wrapText(text, maxChars) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function textSvg(text, box, width, height, index) {
  const x = box.x * width;
  const y = box.y * height;
  const w = box.w * width;
  const h = box.h * height;
  const centerX = x + w / 2;
  const centerY = y + h / 2;
  const maxChars = Math.max(8, Math.floor(w / Math.max(12, width * 0.032)));
  let lines = wrapText(text, maxChars).slice(0, 5);
  const fontSize = Math.max(
    18,
    Math.min(
      h / (lines.length * 1.15),
      (w / Math.max(...lines.map((line) => line.length), 1)) * 1.65,
      width * 0.07,
    ),
  );
  const lineHeight = fontSize * 1.08;
  const totalHeight = lineHeight * lines.length;
  const rotate = box.rotate ? ` rotate(${box.rotate} ${centerX} ${centerY})` : "";
  lines = lines.map(escapeXml);
  const tspans = lines
    .map((line, lineIndex) => {
      const dy = lineIndex === 0 ? -(totalHeight - lineHeight) / 2 : lineHeight;
      return `<tspan x="${centerX.toFixed(1)}" dy="${dy.toFixed(1)}">${line}</tspan>`;
    })
    .join("");
  return `<text class="meme-text" data-box="${index}" transform="translate(0 ${centerY.toFixed(1)})${rotate}" font-size="${fontSize.toFixed(1)}">${tspans}</text>`;
}

function defaultBoxes(count) {
  if (count <= 1) return [{ x: 0.06, y: 0.74, w: 0.88, h: 0.18 }];
  if (count === 2) {
    return [
      { x: 0.06, y: 0.05, w: 0.88, h: 0.18 },
      { x: 0.06, y: 0.76, w: 0.88, h: 0.18 },
    ];
  }
  return Array.from({ length: count }, (_, index) => ({
    x: 0.05,
    y: 0.04 + index * (0.9 / count),
    w: 0.9,
    h: Math.min(0.16, 0.8 / count),
  }));
}

async function renderLocal(template, texts, flags) {
  const { buffer } = await cachedTemplateImage(template);
  const imageMime = extFromUrl(template.imageUrl) === ".png" ? "image/png" : "image/jpeg";
  const imageData = `data:${imageMime};base64,${buffer.toString("base64")}`;
  const boxes = template.boxes?.length
    ? template.boxes
    : defaultBoxes(texts.length || template.fields.length);
  const width = Number(template.width);
  const height = Number(template.height);
  const textNodes = texts
    .map((text, index) =>
      textSvg(text, boxes[index] ?? boxes[boxes.length - 1], width, height, index),
    )
    .join("\n");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <style>
    .meme-text {
      font-family: Impact, "Arial Black", Arial, sans-serif;
      font-weight: 900;
      fill: #fff;
      stroke: #000;
      stroke-width: ${Math.max(3, Math.round(width / 250))};
      paint-order: stroke;
      text-anchor: middle;
      dominant-baseline: middle;
      letter-spacing: 0;
    }
  </style>
  <image href="${imageData}" x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="none"/>
  ${textNodes}
</svg>
`;
  const out = flags.out ?? path.resolve(process.cwd(), `${template.id}.svg`);
  await mkdir(path.dirname(path.resolve(out)), { recursive: true });
  if (path.extname(out).toLowerCase() === ".png") {
    let sharp;
    try {
      sharp = (await import("sharp")).default;
    } catch {
      throw new Error(
        "PNG output needs the optional sharp package. Use --out meme.svg or install sharp near the skill runner.",
      );
    }
    await sharp(Buffer.from(svg)).png().toFile(out);
  } else {
    await writeFile(out, svg, "utf8");
  }
  const size = (await stat(out)).size;
  console.log(`${out} (${size} bytes)`);
}

async function renderImgflip(template, texts, flags) {
  const username = flags.username || process.env.IMGFLIP_USER;
  const password = flags.password || process.env.IMGFLIP_PASS;
  if (!username || !password) {
    throw new Error(
      "Imgflip service requires IMGFLIP_USER and IMGFLIP_PASS, or --username/--password.",
    );
  }
  const body = new URLSearchParams({
    template_id: template.imgflipId,
    username,
    password,
  });
  if ((template.boxes?.length ?? template.fields.length) <= 2) {
    texts.forEach((text, index) => body.set(`text${index}`, text));
  } else {
    texts.forEach((text, index) => body.set(`boxes[${index}][text]`, text));
  }
  const response = await fetch(IMGFLIP_CAPTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body,
  });
  const payload = await response.json();
  if (!payload.success) throw new Error(payload.error_message || "Imgflip caption_image failed");
  console.log(payload.data.url);
}

async function refresh(flags) {
  const limit = Number(flags.limit || 25);
  const response = await fetch(IMGFLIP_GET_MEMES_URL, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) throw new Error(`Imgflip get_memes failed ${response.status}`);
  const payload = await response.json();
  const memes = payload.data.memes.slice(0, limit);
  if (flags.json) {
    console.log(JSON.stringify(memes, null, 2));
  } else {
    for (const meme of memes) {
      console.log(
        `${meme.id}: ${meme.name} (${meme.width}x${meme.height}, boxes=${meme.box_count})`,
      );
      console.log(`  ${meme.url}`);
    }
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) usage(0);
  const [command, ...rest] = flags._;
  if (!command) usage(1);
  const templates = await loadTemplates();

  if (command === "list") {
    printTemplates(templates, flags.json);
    return;
  }
  if (command === "search" || command === "suggest") {
    const query = rest.join(" ");
    if (!query) throw new Error(`${command} needs a query`);
    const limit = Number(flags.limit || (command === "suggest" ? 5 : 20));
    const ranked = templates
      .map((template) => ({ ...template, score: scoreTemplate(template, query) }))
      .filter((template) => template.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    printTemplates(ranked, flags.json);
    return;
  }
  if (command === "render") {
    const selector = rest.join(" ");
    if (!selector) throw new Error("render needs a template id/name");
    const template = findTemplate(templates, selector);
    if (!template) throw new Error(`No matching template: ${selector}`);
    const texts = flags.text ?? [];
    if (!texts.length)
      throw new Error(`Add text with --text. Fields: ${template.fields.join(", ")}`);
    const service = flags.service || "local";
    if (service === "local") {
      await renderLocal(template, texts, flags);
    } else if (service === "imgflip") {
      await renderImgflip(template, texts, flags);
    } else {
      throw new Error(`Unknown service: ${service}`);
    }
    return;
  }
  if (command === "refresh") {
    await refresh(flags);
    return;
  }
  usage(1);
}

main().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exit(1);
});
