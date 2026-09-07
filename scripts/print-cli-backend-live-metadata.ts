// Print Cli Backend Live Metadata script supports OpenClaw repository automation.
import { pathToFileURL } from "node:url";
import { resolveCliBackendConfig, resolveCliBackendLiveTest } from "../src/agents/cli-backends.js";
import { resolvePluginSetupRegistry } from "../src/plugins/setup-registry.js";

export async function resolveCliBackendLiveMetadata(provider: string) {
  if (provider === "codex-cli") {
    return {
      provider,
      unsupported: true,
      reason:
        "codex-cli is no longer a bundled CLI backend. Use openai/* with the Codex app-server runtime instead.",
    };
  }

  return await buildBackendMetadata(provider);
}

async function buildBackendMetadata(provider: string) {
  const resolved = resolveCliBackendConfig(provider);
  const liveTest = resolveCliBackendLiveTest(provider);
  const fallbackBackend =
    !resolved || !liveTest?.defaultModelRef ? await loadFallbackBackend(provider) : null;
  const backendConfig = resolved?.config ?? fallbackBackend?.config;
  const backendLiveTest =
    liveTest ??
    (fallbackBackend
      ? {
          defaultModelRef: fallbackBackend.liveTest?.defaultModelRef,
          defaultImageProbe: fallbackBackend.liveTest?.defaultImageProbe === true,
          defaultMcpProbe: fallbackBackend.liveTest?.defaultMcpProbe === true,
          dockerNpmPackage: fallbackBackend.liveTest?.docker?.npmPackage,
          dockerBinaryName: fallbackBackend.liveTest?.docker?.binaryName,
        }
      : null);

  return {
    provider,
    command: backendConfig?.command,
    args: backendConfig?.args,
    clearEnv: backendConfig?.clearEnv ?? [],
    imageArg: backendConfig?.imageArg,
    imageMode: backendConfig?.imageMode,
    systemPromptWhen: backendConfig?.systemPromptWhen ?? "never",
    bundleMcp: resolved?.bundleMcp === true || fallbackBackend?.bundleMcp === true,
    bundleMcpMode: resolved?.bundleMcpMode ?? fallbackBackend?.bundleMcpMode,
    defaultModelRef: backendLiveTest?.defaultModelRef,
    defaultImageProbe: backendLiveTest?.defaultImageProbe === true,
    defaultMcpProbe: backendLiveTest?.defaultMcpProbe === true,
    dockerNpmPackage: backendLiveTest?.dockerNpmPackage,
    dockerBinaryName: backendLiveTest?.dockerBinaryName,
  };
}

async function loadFallbackBackend(id: string) {
  switch (id) {
    case "claude-cli": {
      const mod = await import("../extensions/anthropic/cli-backend.ts");
      return mod.buildAnthropicCliBackend();
    }
    case "google-gemini-cli": {
      const mod = await import("../extensions/google/cli-backend.ts");
      return mod.buildGoogleGeminiCliBackend();
    }
    default:
      return null;
  }
}

export async function resolveCliBackendDockerPackages(
  requestedProviders: readonly string[] = [],
  requestedModels: readonly string[] = [],
) {
  // Only explicit model refs contribute providers; modern/small/all keep the
  // provider filter intact, including its unrestricted default.
  const requested = new Set(
    [
      ...requestedProviders,
      ...requestedModels.flatMap((modelRef) => {
        const slash = modelRef.indexOf("/");
        return slash > 0 && modelRef.slice(slash + 1).trim() ? [modelRef.slice(0, slash)] : [];
      }),
    ]
      .map((provider) => provider.trim().toLowerCase())
      .filter((provider) => provider && provider !== "all"),
  );
  const backends = resolvePluginSetupRegistry().cliBackends;
  const providers = requested.size
    ? [
        ...requested,
        ...backends
          .filter(({ backend }) => backend.modelProvider && requested.has(backend.modelProvider))
          .map(({ backend }) => backend.id),
      ]
    : backends.map(({ backend }) => backend.id);
  const packages = new Set<string>();
  for (const provider of providers) {
    const metadata = await resolveCliBackendLiveMetadata(provider);
    if ("dockerNpmPackage" in metadata && metadata.dockerNpmPackage) {
      packages.add(metadata.dockerNpmPackage);
    }
  }
  return [...packages].toSorted();
}

async function main() {
  if (process.argv[2] === "--docker-packages") {
    const packages = await resolveCliBackendDockerPackages(
      process.argv[3]?.split(","),
      process.argv[4]?.split(","),
    );
    for (const npmPackage of packages) {
      process.stdout.write(`${npmPackage}\n`);
    }
    return;
  }
  const provider = process.argv[2]?.trim().toLowerCase();
  if (!provider) {
    console.error("usage: node scripts/print-cli-backend-live-metadata.ts <provider>");
    process.exit(1);
  }

  process.stdout.write(JSON.stringify(await resolveCliBackendLiveMetadata(provider), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
