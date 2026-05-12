import path from "node:path";
import type { WindowsGuest } from "./guest-transports.ts";
import { die, run, say } from "./host-command.ts";
import { psSingleQuote } from "./powershell.ts";
import type { HostServer } from "./types.ts";

export async function prepareMinGitZip(tgzDir: string): Promise<string> {
  const metadata = run(
    "python3",
    [
      "-c",
      String.raw`import json
import urllib.request

preferred_names = [
    "MinGit-2.53.0.2-arm64.zip",
    "MinGit-2.53.0.2-64-bit.zip",
]
fallback_urls = {
    "MinGit-2.53.0.2-arm64.zip": "https://github.com/git-for-windows/git/releases/download/v2.53.0.windows.2/MinGit-2.53.0.2-arm64.zip",
    "MinGit-2.53.0.2-64-bit.zip": "https://github.com/git-for-windows/git/releases/download/v2.53.0.windows.2/MinGit-2.53.0.2-64-bit.zip",
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
    print(preferred_names[0])
    print(fallback_urls[preferred_names[0]])
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
        if "-arm64." in name:
            rank = 0
        elif "-64-bit." in name:
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

print(best["name"])
print(best["browser_download_url"])`,
    ],
    { quiet: true },
  ).stdout.trim();
  const [name, url] = metadata.split("\n");
  if (!name || !url) {
    die("failed to resolve MinGit download metadata");
  }
  const zipPath = path.join(tgzDir, name);
  say(`Download ${name}`);
  run("curl", [
    "--retry",
    "5",
    "--retry-delay",
    "3",
    "--retry-all-errors",
    "-fsSL",
    url,
    "-o",
    zipPath,
  ]);
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
curl.exe -fsSL ${psSingleQuote(minGitUrl)} -o $archive
tar.exe -xf $archive -C $portableGit
Remove-Item $archive -Force -ErrorAction SilentlyContinue
$env:PATH = "$portableGit\\cmd;$portableGit\\mingw64\\bin;$portableGit\\usr\\bin;$env:PATH"
git.exe --version`,
    { timeoutMs: 1_200_000 },
  );
}
