import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  installCompletion,
  isCompletionInstalled,
  resolveCompletionCachePath,
  resolveCompletionProfilePath,
  usesSlowDynamicCompletion,
} from "./completion-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runPowerShell(command: string, env: NodeJS.ProcessEnv) {
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
}

describe.skipIf(process.platform !== "win32")("PowerShell profile encoding", () => {
  it.each([
    { name: "UTF16LE", outFileEncoding: "Unicode", decoder: "utf-16le", bom: "fffe" },
    { name: "UTF16BE", outFileEncoding: "BigEndianUnicode", decoder: "utf-16be", bom: "feff" },
    { name: "UTF8 BOM", outFileEncoding: "utf8", decoder: "utf-8", bom: "efbbbf" },
    { name: "unmarked UTF8", outFileEncoding: null, decoder: "utf-8", bom: "" },
  ])(
    "preserves and reloads a $name profile during cached completion installation",
    async (encoding) => {
      const homeDir = tempDirs.make("openclaw-powershell-profile-");
      await withEnvAsync(
        {
          HOME: homeDir,
          USERPROFILE: homeDir,
          OPENCLAW_HOME: undefined,
          OPENCLAW_STATE_DIR: path.join(homeDir, "state"),
          SHELL: "powershell.exe",
        },
        async () => {
          const profilePath = resolveCompletionProfilePath("powershell");
          const cachePath = resolveCompletionCachePath("powershell", "openclaw");
          const greeting = encoding.bom ? "café €" : "plain ASCII control";
          const userLine = `$global:ProfileGreeting = '${greeting}'`;
          const dynamicLine =
            "openclaw completion --shell powershell | Out-String | Invoke-Expression";
          await fs.mkdir(path.dirname(profilePath), { recursive: true });
          await fs.mkdir(path.dirname(cachePath), { recursive: true });
          await fs.writeFile(cachePath, "$global:CompletionCacheLoaded = $true\r\n", "utf8");
          const fixtureCommand = encoding.outFileEncoding
            ? `$env:PROFILE_FIXTURE_TEXT | Out-File -LiteralPath $env:PROFILE_FIXTURE_PATH -NoNewline -Encoding ${encoding.outFileEncoding}`
            : "[IO.File]::WriteAllText($env:PROFILE_FIXTURE_PATH, $env:PROFILE_FIXTURE_TEXT, [Text.UTF8Encoding]::new($false))";
          const fixture = runPowerShell(`$ErrorActionPreference = 'Stop'; ${fixtureCommand}`, {
            PROFILE_FIXTURE_PATH: profilePath,
            PROFILE_FIXTURE_TEXT: `${dynamicLine}\r\n${userLine}\r\n`,
          });
          expect(fixture.error).toBeUndefined();
          expect(fixture.status, fixture.stderr).toBe(0);

          const beforeSlow = await usesSlowDynamicCompletion("powershell", "openclaw");
          await installCompletion("powershell", true, "openclaw");
          const bytes = await fs.readFile(profilePath);
          const content = new TextDecoder(encoding.decoder).decode(bytes);
          const prefix = bytes.subarray(0, 3).toString("hex");
          const observedBom = prefix.startsWith("fffe")
            ? "fffe"
            : prefix.startsWith("feff")
              ? "feff"
              : prefix === "efbbbf"
                ? "efbbbf"
                : "";
          const loaded = runPowerShell(
            `
        $ErrorActionPreference = 'Stop'
        . $env:PROFILE_FIXTURE_PATH
        @{
          greeting = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($global:ProfileGreeting))
          completionLoaded = $global:CompletionCacheLoaded -eq $true
          powershellMajor = $PSVersionTable.PSVersion.Major
        } | ConvertTo-Json -Compress
      `,
            { PROFILE_FIXTURE_PATH: profilePath },
          );
          const loadedState = loaded.status === 0 ? JSON.parse(loaded.stdout.trim()) : null;
          await installCompletion("powershell", true, "openclaw");

          expect({
            beforeSlow,
            bom: observedBom,
            dynamicRemoved: !content.includes(dynamicLine),
            userTextPreserved: content.includes(userLine),
            installed: await isCompletionInstalled("powershell", "openclaw"),
            profileExit: loaded.status,
            loadedState,
            stableOnReinstall: bytes.equals(await fs.readFile(profilePath)),
          }).toEqual({
            beforeSlow: true,
            bom: encoding.bom,
            dynamicRemoved: true,
            userTextPreserved: true,
            installed: true,
            profileExit: 0,
            loadedState: {
              greeting: Buffer.from(greeting, "utf8").toString("base64"),
              completionLoaded: true,
              powershellMajor: 5,
            },
            stableOnReinstall: true,
          });
        },
      );
    },
    60_000,
  );
});
