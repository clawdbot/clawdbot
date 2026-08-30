import {
  parseBrowserNativeHostOrigins,
  runBrowserNativeHost,
} from "./src/browser/extension-native-host.js";

function requiredArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  const { callerOrigin, expectedOrigins } = parseBrowserNativeHostOrigins(process.argv.slice(2));
  let responseFrame: Buffer | undefined;
  await runBrowserNativeHost({
    manifestPath: requiredArgument("--manifest"),
    launcherPath: requiredArgument("--launcher"),
    callerOrigin,
    expectedOrigins,
    input: process.stdin,
    write: (frame) => {
      responseFrame = frame;
    },
    buildPairing: async () => {
      // Config and relay-key work must remain behind the host's validation boundary.
      const { buildBrowserNativeHostPairing } =
        await import("./src/browser/extension-native-host.runtime.js");
      return await buildBrowserNativeHostPairing();
    },
  });
  const response = responseFrame;
  if (!response) {
    throw new Error("Native host produced no response frame");
  }
  await new Promise<void>((resolve) => {
    process.stdout.write(response, () => resolve());
  });
}

void main().catch(() => {
  process.exitCode = 1;
});
