import type { Command } from "commander";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";
import {
  loadBundledPluginPublicSurfaceModuleSync,
  tryLoadActivatedBundledPluginPublicSurfaceModuleSync,
} from "./facade-runtime.js";

export type QaRunnerCliRegistration = {
  commandName: string;
  register(qa: Command): void;
};

type QaRunnerRuntimeSurface = {
  qaRunnerCliRegistrations?: readonly QaRunnerCliRegistration[];
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

function listDeclaredQaRunnerPlugins(): Array<
  PluginManifestRecord & {
    qaRunners: NonNullable<PluginManifestRecord["qaRunners"]>;
  }
> {
  return loadPluginManifestRegistry({ cache: true })
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

function loadQaRunnerRuntimeSurface(plugin: PluginManifestRecord): QaRunnerRuntimeSurface | null {
  if (plugin.origin === "bundled") {
    return loadBundledPluginPublicSurfaceModuleSync<QaRunnerRuntimeSurface>({
      dirName: plugin.id,
      artifactBasename: "runtime-api.js",
    });
  }
  return tryLoadActivatedBundledPluginPublicSurfaceModuleSync<QaRunnerRuntimeSurface>({
    dirName: plugin.id,
    artifactBasename: "runtime-api.js",
  });
}

export function listQaRunnerCliContributions(): readonly QaRunnerCliContribution[] {
  const contributions = new Map<string, QaRunnerCliContribution>();

  for (const plugin of listDeclaredQaRunnerPlugins()) {
    const runtimeSurface = loadQaRunnerRuntimeSurface(plugin);
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
