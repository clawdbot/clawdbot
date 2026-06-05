// Hook frontmatter helpers parse metadata blocks from hook files.
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import { parseFrontmatterBlock } from "../../packages/markdown-core/src/frontmatter.js";
import {
  applyOpenClawManifestInstallCommonFields,
  getFrontmatterString,
  normalizeStringList,
  parseOpenClawManifestInstallBase,
  parseFrontmatterBool,
  resolveOpenClawManifestBlock,
  resolveOpenClawManifestInstall,
  resolveOpenClawManifestOs,
  resolveOpenClawManifestRequires,
} from "../shared/frontmatter.js";
import type {
  OpenClawHookMetadata,
  HookEntry,
  HookInstallSpec,
  HookInvocationPolicy,
  ParsedHookFrontmatter,
} from "./types.js";

/** Parse HOOK.md frontmatter into the generic hook frontmatter record. */
export function parseFrontmatter(content: string): ParsedHookFrontmatter {
  return parseFrontmatterBlock(content);
}

function parseInstallSpec(input: unknown): HookInstallSpec | undefined {
  const parsed = parseOpenClawManifestInstallBase(input, ["bundled", "npm", "git"]);
  if (!parsed) {
    return undefined;
  }
  const { raw } = parsed;
  const spec = applyOpenClawManifestInstallCommonFields<HookInstallSpec>(
    {
      kind: parsed.kind as HookInstallSpec["kind"],
    },
    parsed,
  );
  if (typeof raw.package === "string") {
    spec.package = raw.package;
  }
  if (typeof raw.repository === "string") {
    spec.repository = raw.repository;
  }

  return spec;
}

/** Resolve OpenClaw hook metadata from the manifest block in HOOK.md frontmatter. */
export function resolveOpenClawMetadata(
  frontmatter: ParsedHookFrontmatter,
): OpenClawHookMetadata | undefined {
  const metadataObj = resolveOpenClawManifestBlock({ frontmatter });
  if (!metadataObj) {
    return undefined;
  }
  const requires = resolveOpenClawManifestRequires(metadataObj);
  const install = resolveOpenClawManifestInstall(metadataObj, parseInstallSpec);
  const osRaw = resolveOpenClawManifestOs(metadataObj);
  const eventsRaw = normalizeStringList(metadataObj.events);
  return {
    always: typeof metadataObj.always === "boolean" ? metadataObj.always : undefined,
    emoji: readStringValue(metadataObj.emoji),
    homepage: readStringValue(metadataObj.homepage),
    hookKey: readStringValue(metadataObj.hookKey),
    export: readStringValue(metadataObj.export),
    os: osRaw.length > 0 ? osRaw : undefined,
    events: eventsRaw.length > 0 ? eventsRaw : [],
    requires,
    install: install.length > 0 ? install : undefined,
  };
}

/** Resolve invocation policy from top-level hook frontmatter flags. */
export function resolveHookInvocationPolicy(
  frontmatter: ParsedHookFrontmatter,
): HookInvocationPolicy {
  return {
    enabled: parseFrontmatterBool(getFrontmatterString(frontmatter, "enabled"), true),
  };
}

/** Resolve the config key for a hook, honoring metadata hookKey overrides. */
export function resolveHookKey(hookName: string, entry?: HookEntry): string {
  return entry?.metadata?.hookKey ?? hookName;
}
