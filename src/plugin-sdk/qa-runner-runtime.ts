import type { Command } from "commander";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";
import {
  loadBundledPluginPublicSurfaceModuleSync,
  tryLoadActivatedBundledPluginPublicSurfaceModuleSync,
} from "./facade-runtime.js";
import { resolvePrivateQaBundledPluginsEnv } from "./private-qa-bundled-env.js";

export type QaRunnerCliRegistration = {
  commandName: string;
  register(qa: Command): void;
};

type QaRunnerRuntimeSurface = {
  qaRunnerCliRegistrations?: readonly QaRunnerCliRegistration[];
};

type QaRuntimeSurface = {
  defaultQaRuntimeModelForMode: (
    mode: string,
    options?: {
      alternate?: boolean;
      preferredLiveModel?: string;
    },
  ) => string;
  startQaLiveLaneGateway: (...args: unknown[]) => Promise<unknown>;
};

export type QaRunnerCliContribution =
  | {
      pluginId: string;
      commandName: string;
      description?: string;
      status: "available";
      registration: QaRunnerCliRegistration;
    }
  | {
      pluginId: string;
      commandName: string;
      description?: string;
      status: "blocked";
    };

function isMissingQaRuntimeError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.message.includes("qa-lab") &&
    (error.message.includes("runtime-api.js") ||
      error.message.startsWith("Unable to open bundled plugin public surface "))
  );
}

export function loadQaRuntimeModule(): QaRuntimeSurface {
  const env = resolvePrivateQaBundledPluginsEnv();
  return loadBundledPluginPublicSurfaceModuleSync<QaRuntimeSurface>({
    dirName: ["qa", "lab"].join("-"),
    artifactBasename: ["runtime-api", "js"].join("."),
    ...(env ? { env } : {}),
  });
}

export function isQaRuntimeAvailable(): boolean {
  try {
    loadQaRuntimeModule();
    return true;
  } catch (error) {
    if (isMissingQaRuntimeError(error)) {
      return false;
    }
    throw error;
  }
}

function listDeclaredQaRunnerPlugins(
  env: NodeJS.ProcessEnv | undefined = resolvePrivateQaBundledPluginsEnv(),
): Array<
  PluginManifestRecord & {
    qaRunners: NonNullable<PluginManifestRecord["qaRunners"]>;
  }
> {
  return loadPluginManifestRegistry({ cache: true, ...(env ? { env } : {}) })
    .plugins.filter(
      (
        plugin,
      ): plugin is PluginManifestRecord & {
        qaRunners: NonNullable<PluginManifestRecord["qaRunners"]>;
      } => Array.isArray(plugin.qaRunners) && plugin.qaRunners.length > 0,
    )
    .toSorted((left, right) => {
      const idCompare = left.id.localeCompare(right.id);
      if (idCompare !== 0) {
        return idCompare;
      }
      return left.rootDir.localeCompare(right.rootDir);
    });
}

function indexRuntimeRegistrations(
  pluginId: string,
  surface: QaRunnerRuntimeSurface,
): ReadonlyMap<string, QaRunnerCliRegistration> {
  const registrations = surface.qaRunnerCliRegistrations ?? [];
  const registrationByCommandName = new Map<string, QaRunnerCliRegistration>();
  for (const registration of registrations) {
    if (!registration?.commandName || typeof registration.register !== "function") {
      throw new Error(`QA runner plugin "${pluginId}" exported an invalid CLI registration`);
    }
    if (registrationByCommandName.has(registration.commandName)) {
      throw new Error(
        `QA runner plugin "${pluginId}" exported duplicate CLI registration "${registration.commandName}"`,
      );
    }
    registrationByCommandName.set(registration.commandName, registration);
  }
  return registrationByCommandName;
}

function loadQaRunnerRuntimeSurface(
  plugin: PluginManifestRecord,
  env?: NodeJS.ProcessEnv,
): QaRunnerRuntimeSurface | null {
  if (plugin.origin === "bundled") {
    return loadBundledPluginPublicSurfaceModuleSync<QaRunnerRuntimeSurface>({
      dirName: plugin.id,
      artifactBasename: "runtime-api.js",
      ...(env ? { env } : {}),
    });
  }
  return tryLoadActivatedBundledPluginPublicSurfaceModuleSync<QaRunnerRuntimeSurface>({
    dirName: plugin.id,
    artifactBasename: "runtime-api.js",
    ...(env ? { env } : {}),
  });
}

export function listQaRunnerCliContributions(): readonly QaRunnerCliContribution[] {
  const env = resolvePrivateQaBundledPluginsEnv();
  const contributions = new Map<string, QaRunnerCliContribution>();

  for (const plugin of listDeclaredQaRunnerPlugins(env)) {
    const runtimeSurface = loadQaRunnerRuntimeSurface(plugin, env);
    const runtimeRegistrationByCommandName = runtimeSurface
      ? indexRuntimeRegistrations(plugin.id, runtimeSurface)
      : null;
    const declaredCommandNames = new Set(plugin.qaRunners.map((runner) => runner.commandName));

    for (const runner of plugin.qaRunners) {
      const previous = contributions.get(runner.commandName);
      if (previous && previous.pluginId !== plugin.id) {
        throw new Error(
          `QA runner command "${runner.commandName}" declared by both "${previous.pluginId}" and "${plugin.id}"`,
        );
      }

      const registration = runtimeRegistrationByCommandName?.get(runner.commandName);
      if (!runtimeSurface) {
        contributions.set(runner.commandName, {
          pluginId: plugin.id,
          commandName: runner.commandName,
          ...(runner.description ? { description: runner.description } : {}),
          status: "blocked",
        });
        continue;
      }
      if (!registration) {
        throw new Error(
          `QA runner plugin "${plugin.id}" declared "${runner.commandName}" in openclaw.plugin.json but did not export a matching CLI registration`,
        );
      }
      contributions.set(runner.commandName, {
        pluginId: plugin.id,
        commandName: runner.commandName,
        ...(runner.description ? { description: runner.description } : {}),
        status: "available",
        registration,
      });
    }

    for (const commandName of runtimeRegistrationByCommandName?.keys() ?? []) {
      if (!declaredCommandNames.has(commandName)) {
        throw new Error(
          `QA runner plugin "${plugin.id}" exported "${commandName}" from runtime-api.js but did not declare it in openclaw.plugin.json`,
        );
      }
    }
  }

  return [...contributions.values()];
}
