// Windows Git script supports OpenClaw repository automation.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import type { WindowsGuest } from "./guest-transports.ts";
import { die, run, say } from "./host-command.ts";
import { psSingleQuote } from "./powershell.ts";
import type { HostServer } from "./types.ts";

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function prepareMinGitZip(tgzDir: string): Promise<string> {
  const metadata = run(
    "python3",
    [
      "-c",
      String.raw`import json
import re
import urllib.request

preferred_names = [
    "MinGit-2.55.0.4-64-bit.zip",
    "MinGit-2.55.0.4-arm64.zip",
]
fallback_assets = {
    "MinGit-2.55.0.4-arm64.zip": {
        "browser_download_url": "https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.4/MinGit-2.55.0.4-arm64.zip",
        "digest": "sha256:033eb6b927d804558ae479a6ae6c6ed86da42cabc0d424844a3e108c780a58cc",
    },
    "MinGit-2.55.0.4-64-bit.zip": {
        "browser_download_url": "https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.4/MinGit-2.55.0.4-64-bit.zip",
        "digest": "sha256:4e03f94c2ffbf70be337e005cee02661c732dbfc81031a078bda9299b9a7d644",
    },
}

try:
    req = urllib.request.Request(
        "https://api.github.com/repos/git-for-windows/git/releases/latest",
        headers={
            "User-Agent": "openclaw-parallels-smoke",
            "Accept": "application/vnd.github+json",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        data = json.load(response)
except Exception:
    fallback = fallback_assets[preferred_names[0]]
    print(preferred_names[0])
    print(fallback["browser_download_url"])
    print(fallback["digest"])
    raise SystemExit(0)

assets = data.get("assets", [])

best = None
for wanted in preferred_names:
    for asset in assets:
        if asset.get("name") == wanted:
            best = asset
            break
    if best:
        break

if best is None:
    candidates = []
    for asset in assets:
        name = asset.get("name", "")
        if not (name.startswith("MinGit-") and name.endswith(".zip")):
            continue
        if "busybox" in name:
            continue
        if "-64-bit." in name:
            rank = 0
        elif "-arm64." in name:
            rank = 1
        elif "-32-bit." in name:
            rank = 2
        else:
            rank = 3
        candidates.append((rank, name, asset))
    if candidates:
        best = sorted(candidates, key=lambda item: (item[0], item[1]))[0][2]

if best is None:
    raise SystemExit("no MinGit asset found")

digest = best.get("digest", "")
if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
    raise SystemExit("MinGit asset missing SHA-256 digest")

print(best["name"])
print(best["browser_download_url"])
print(digest)`,
    ],
    { quiet: true },
  ).stdout.trim();
  const [name, url, digest] = metadata.split("\n");
  const expectedSha256 = digest?.match(/^sha256:([a-f\d]{64})$/u)?.[1];
  if (!name || !url || !expectedSha256) {
    die("failed to resolve checksummed MinGit download metadata");
  }
  const zipPath = path.join(tgzDir, name);
  say(`Download ${name}`);
  run(
    "curl",
    [
      "--retry",
      "5",
      "--retry-delay",
      "3",
      "--retry-all-errors",
      "--connect-timeout",
      "10",
      "--max-time",
      "120",
      "--retry-max-time",
      "120",
      "-fsSL",
      url,
      "-o",
      zipPath,
    ],
    {
      // curl can start one final 120s transfer at the retry-window edge.
      timeoutMs: 270_000,
    },
  );
  const actualSha256 = await sha256File(zipPath);
  if (actualSha256 !== expectedSha256) {
    throw new Error(`MinGit SHA-256 mismatch: expected ${expectedSha256}, got ${actualSha256}`);
  }
  return zipPath;
}

export function ensureGuestGit(input: {
  guest: WindowsGuest;
  server: HostServer | null;
  minGitZipPath: string;
}): void {
  const existing = input.guest.exec(
    ["cmd.exe", "/d", "/s", "/c", "where git.exe && git.exe --version"],
    {
      check: false,
      timeoutMs: 120_000,
    },
  );
  if (existing.includes("git version")) {
    return;
  }
  if (!input.server || !input.minGitZipPath) {
    die("MinGit artifact/server missing");
  }
  const minGitUrl = input.server.urlFor(input.minGitZipPath);
  const minGitName = path.basename(input.minGitZipPath);
  input.guest.powershell(
    `$ErrorActionPreference = 'Stop'
$depsRoot = Join-Path $env:LOCALAPPDATA 'OpenClaw\\deps'
$portableGit = Join-Path $depsRoot 'portable-git'
$archive = Join-Path $env:TEMP ${psSingleQuote(minGitName)}
if (Test-Path $portableGit) {
  Remove-Item $portableGit -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $portableGit | Out-Null
curl.exe -fsSL --connect-timeout 10 --max-time 120 --retry 2 --retry-delay 2 ${psSingleQuote(minGitUrl)} -o $archive
tar.exe -xf $archive -C $portableGit
Remove-Item $archive -Force -ErrorAction SilentlyContinue
$env:PATH = "$portableGit\\cmd;$portableGit\\mingw64\\bin;$portableGit\\usr\\bin;$env:PATH"
git.exe --version`,
    { timeoutMs: 1_200_000 },
  );
}
