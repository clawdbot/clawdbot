import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import { parseRegistryNpmSpec, type ParsedRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { PluginPackageInstall } from "./manifest.js";

export type PluginInstallSourceWarning =
  | "invalid-clawhub-spec"
  | "invalid-npm-spec"
  | "invalid-default-choice"
  | "default-choice-missing-source"
  | "clawhub-spec-floating"
  | "npm-integrity-without-source"
  | "npm-spec-floating"
  | "npm-spec-missing-integrity"
  | "npm-spec-package-name-mismatch";

export type PluginInstallNpmPinState =
  | "exact-with-integrity"
  | "exact-without-integrity"
  | "floating-with-integrity"
  | "floating-without-integrity";

export type PluginInstallNpmSourceInfo = {
  spec: string;
  packageName: string;
  expectedPackageName?: string;
  selector?: string;
  selectorKind: ParsedRegistryNpmSpec["selectorKind"];
  exactVersion: boolean;
  expectedIntegrity?: string;
  pinState: PluginInstallNpmPinState;
};

export type PluginInstallLocalSourceInfo = {
  path: string;
};

export type PluginInstallClawHubSourceInfo = {
  spec: string;
  packageName: string;
  version?: string;
  exactVersion: boolean;
};

export type PluginInstallSourceInfo = {
  defaultChoice?: PluginPackageInstall["defaultChoice"];
  clawhub?: PluginInstallClawHubSourceInfo;
  npm?: PluginInstallNpmSourceInfo;
  local?: PluginInstallLocalSourceInfo;
  warnings: readonly PluginInstallSourceWarning[];
};

export type DescribePluginInstallSourceOptions = {
  expectedPackageName?: string | null;
};

function resolveNpmPinState(params: {
  exactVersion: boolean;
  hasIntegrity: boolean;
}): PluginInstallNpmPinState {
  if (params.exactVersion) {
    return params.hasIntegrity ? "exact-with-integrity" : "exact-without-integrity";
  }
  return params.hasIntegrity ? "floating-with-integrity" : "floating-without-integrity";
}

function resolveDefaultChoice(value: unknown): PluginPackageInstall["defaultChoice"] | undefined {
  return value === "clawhub" || value === "npm" || value === "local" ? value : undefined;
}

function normalizeExpectedPackageName(value: string | null | undefined): string | undefined {
  const expected = normalizeOptionalString(value);
  if (!expected) {
    return undefined;
  }
  return parseRegistryNpmSpec(expected)?.name ?? expected;
}

export function describePluginInstallSource(
  install: PluginPackageInstall,
  options?: DescribePluginInstallSourceOptions,
): PluginInstallSourceInfo {
  const clawhubSpec = normalizeOptionalString(install.clawhubSpec);
  const npmSpec = normalizeOptionalString(install.npmSpec);
  const localPath = normalizeOptionalString(install.localPath);
  const defaultChoice = resolveDefaultChoice(install.defaultChoice);
  const expectedIntegrity = normalizeOptionalString(install.expectedIntegrity);
  const expectedPackageName = normalizeExpectedPackageName(options?.expectedPackageName);
  const warnings: PluginInstallSourceWarning[] = [];
  let clawhub: PluginInstallClawHubSourceInfo | undefined;
  let npm: PluginInstallNpmSourceInfo | undefined;

  if (install.defaultChoice !== undefined && !defaultChoice) {
    warnings.push("invalid-default-choice");
  }

  if (clawhubSpec) {
    const parsed = parseClawHubPluginSpec(clawhubSpec);
    if (parsed) {
      if (!parsed.version) {
        warnings.push("clawhub-spec-floating");
      }
      clawhub = {
        spec: clawhubSpec,
        packageName: parsed.name,
        ...(parsed.version ? { version: parsed.version } : {}),
        exactVersion: Boolean(parsed.version),
      };
    } else {
      warnings.push("invalid-clawhub-spec");
    }
  }

  if (npmSpec) {
    const parsed = parseRegistryNpmSpec(npmSpec);
    if (parsed) {
      const exactVersion = parsed.selectorKind === "exact-version";
      const hasIntegrity = Boolean(expectedIntegrity);
      if (!exactVersion) {
        warnings.push("npm-spec-floating");
      }
      if (!hasIntegrity) {
        warnings.push("npm-spec-missing-integrity");
      }
      if (expectedPackageName && parsed.name !== expectedPackageName) {
        warnings.push("npm-spec-package-name-mismatch");
      }
      npm = {
        spec: parsed.raw,
        packageName: parsed.name,
        ...(expectedPackageName && parsed.name !== expectedPackageName
          ? { expectedPackageName }
          : {}),
        selectorKind: parsed.selectorKind,
        exactVersion,
        pinState: resolveNpmPinState({ exactVersion, hasIntegrity }),
        ...(parsed.selector ? { selector: parsed.selector } : {}),
        ...(expectedIntegrity ? { expectedIntegrity } : {}),
      };
    } else {
      warnings.push("invalid-npm-spec");
    }
  }
  if (defaultChoice === "clawhub" && !clawhub) {
    warnings.push("default-choice-missing-source");
  }
  if (defaultChoice === "npm" && !npm) {
    warnings.push("default-choice-missing-source");
  }
  if (defaultChoice === "local" && !localPath) {
    warnings.push("default-choice-missing-source");
  }
  if (expectedIntegrity && !npm) {
    warnings.push("npm-integrity-without-source");
  }

  return {
    ...(defaultChoice ? { defaultChoice } : {}),
    ...(clawhub ? { clawhub } : {}),
    ...(npm ? { npm } : {}),
    ...(localPath ? { local: { path: localPath } } : {}),
    warnings,
  };
}
