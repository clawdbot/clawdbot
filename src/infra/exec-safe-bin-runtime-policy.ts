import { resolveSafeBins } from "./exec-approvals-allowlist.js";
import {
  normalizeSafeBinProfileFixtures,
  resolveSafeBinProfiles,
  type SafeBinProfile,
  type SafeBinProfileFixture,
  type SafeBinProfileFixtures,
} from "./exec-safe-bin-policy.js";
import { normalizeSafeBinName } from "./exec-safe-bin-semantics.js";
import {
  getTrustedSafeBinDirs,
  listWritableExplicitTrustedSafeBinDirs,
  normalizeTrustedSafeBinDirs,
  type WritableTrustedSafeBinDir,
} from "./exec-safe-bin-trust.js";

type ExecSafeBinConfigScope = {
  safeBins?: string[] | null;
  safeBinProfiles?: SafeBinProfileFixtures | null;
  safeBinTrustedDirs?: string[] | null;
};

const INTERPRETER_LIKE_SAFE_BINS = new Set([
  "ash",
  "awk",
  "bash",
  "busybox",
  "bun",
  "cmd",
  "cmd.exe",
  "cscript",
  "dash",
  "deno",
  "fish",
  "gawk",
  "gsed",
  "ksh",
  "lua",
  "mawk",
  "nawk",
  "node",
  "nodejs",
  "perl",
  "php",
  "powershell",
  "powershell.exe",
  "pypy",
  "pwsh",
  "pwsh.exe",
  "python",
  "python2",
  "python3",
  "ruby",
  "sed",
  "sh",
  "toybox",
  "wscript",
  "zsh",
]);

const INTERPRETER_LIKE_PATTERNS = [
  /^python\d+(?:\.\d+)?$/,
  /^ruby\d+(?:\.\d+)?$/,
  /^perl\d+(?:\.\d+)?$/,
  /^php\d+(?:\.\d+)?$/,
  /^node\d+(?:\.\d+)?$/,
];

export function isInterpreterLikeSafeBin(raw: string): boolean {
  const normalized = normalizeSafeBinName(raw);
  if (!normalized) {
    return false;
  }
  if (INTERPRETER_LIKE_SAFE_BINS.has(normalized)) {
    return true;
  }
  return INTERPRETER_LIKE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function listInterpreterLikeSafeBins(entries: Iterable<string>): string[] {
  return Array.from(entries)
    .map((entry) => normalizeSafeBinName(entry))
    .filter((entry) => entry.length > 0 && isInterpreterLikeSafeBin(entry))
    .toSorted();
}

export function resolveMergedSafeBinProfileFixtures(params: {
  global?: ExecSafeBinConfigScope | null;
  local?: ExecSafeBinConfigScope | null;
}): Record<string, SafeBinProfileFixture> | undefined {
  const global = normalizeSafeBinProfileFixtures(params.global?.safeBinProfiles);
  const local = normalizeSafeBinProfileFixtures(params.local?.safeBinProfiles);
  if (Object.keys(global).length === 0 && Object.keys(local).length === 0) {
    return undefined;
  }
  return {
    ...global,
    ...local,
  };
}

export function resolveExecSafeBinRuntimePolicy(params: {
  global?: ExecSafeBinConfigScope | null;
  local?: ExecSafeBinConfigScope | null;
  onWarning?: (message: string) => void;
}): {
  safeBins: Set<string>;
  safeBinProfiles: Readonly<Record<string, SafeBinProfile>>;
  trustedSafeBinDirs: ReadonlySet<string>;
  unprofiledSafeBins: string[];
  unprofiledInterpreterSafeBins: string[];
  writableTrustedSafeBinDirs: ReadonlyArray<WritableTrustedSafeBinDir>;
} {
  const safeBins = resolveSafeBins(params.local?.safeBins ?? params.global?.safeBins);
  const safeBinProfiles = resolveSafeBinProfiles(
    resolveMergedSafeBinProfileFixtures({
      global: params.global,
      local: params.local,
    }),
  );
  const unprofiledSafeBins = Array.from(safeBins)
    .filter((entry) => !safeBinProfiles[entry])
    .toSorted();
  const explicitTrustedSafeBinDirs = [
    ...normalizeTrustedSafeBinDirs(params.global?.safeBinTrustedDirs),
    ...normalizeTrustedSafeBinDirs(params.local?.safeBinTrustedDirs),
  ];
  const trustedSafeBinDirs = getTrustedSafeBinDirs({
    extraDirs: explicitTrustedSafeBinDirs,
  });
  const writableTrustedSafeBinDirs = listWritableExplicitTrustedSafeBinDirs(
    explicitTrustedSafeBinDirs,
  );
  if (params.onWarning) {
    for (const hit of writableTrustedSafeBinDirs) {
      const scope =
        hit.worldWritable || hit.groupWritable
          ? hit.worldWritable
            ? "world-writable"
            : "group-writable"
          : "writable";
      params.onWarning(
        `exec: safeBinTrustedDirs includes ${scope} directory '${hit.dir}'; remove trust or tighten permissions (for example chmod 755).`,
      );
    }
  }
  return {
    safeBins,
    safeBinProfiles,
    trustedSafeBinDirs,
    unprofiledSafeBins,
    unprofiledInterpreterSafeBins: listInterpreterLikeSafeBins(unprofiledSafeBins),
    writableTrustedSafeBinDirs,
  };
}
