// Covers safe-bin policy profiles, validation, and generated docs text.
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SAFE_BINS,
  SAFE_BIN_PROFILE_FIXTURES,
  SAFE_BIN_PROFILES,
  buildLongFlagPrefixMap,
  collectKnownLongFlags,
  normalizeSafeBinProfileFixtures,
  renderDefaultSafeBinsDocText,
  renderSafeBinDeniedFlagsDocBullets,
  resolveSafeBinProfiles,
  type SafeBinProfileFixtures,
  validateSafeBinArgv,
} from "./exec-safe-bin-policy.js";

const SAFE_BIN_DOC_DEFAULTS_START = '[//]: # "SAFE_BIN_DEFAULTS:START"';
const SAFE_BIN_DOC_DEFAULTS_END = '[//]: # "SAFE_BIN_DEFAULTS:END"';
const SAFE_BIN_DOC_DENIED_FLAGS_START = '[//]: # "SAFE_BIN_DENIED_FLAGS:START"';
const SAFE_BIN_DOC_DENIED_FLAGS_END = '[//]: # "SAFE_BIN_DENIED_FLAGS:END"';
const SAFE_BIN_DOC_PATH = "docs/tools/exec-approvals-advanced.md";

function normalizeGeneratedDocBlock(block: string): string {
  const lines = block.split("\n");
  while (lines[0]?.trim() === "") {
    lines.shift();
  }
  while (lines.at(-1)?.trim() === "") {
    lines.pop();
  }
  let commonIndent = Infinity;
  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    commonIndent = Math.min(commonIndent, line.match(/^ */)?.[0].length ?? 0);
  }
  if (commonIndent <= 0) {
    return lines.join("\n");
  }
  const normalizedLines: string[] = [];
  for (const line of lines) {
    normalizedLines.push(line.slice(Math.min(line.length, commonIndent)));
  }
  return normalizedLines.join("\n");
}

function buildDeniedFlagArgvVariants(flag: string): string[][] {
  const value = "blocked";
  if (flag.startsWith("--")) {
    return [[`${flag}=${value}`], [flag, value], [flag]];
  }
  if (flag.startsWith("-")) {
    return [[`${flag}${value}`], [flag, value], [flag]];
  }
  return [[flag]];
}

describe("exec safe bin policy grep", () => {
  const grepProfile = expectDefined(
    SAFE_BIN_PROFILES.grep,
    "SAFE_BIN_PROFILES.grep test invariant",
  );

  it("allows stdin-only grep when pattern comes from flags", () => {
    expect(validateSafeBinArgv(["-e", "needle"], grepProfile)).toBe(true);
    expect(validateSafeBinArgv(["--regexp=needle"], grepProfile)).toBe(true);
  });

  it("blocks grep positional pattern form to avoid filename ambiguity", () => {
    expect(validateSafeBinArgv(["needle"], grepProfile)).toBe(false);
  });

  it("blocks file positionals when pattern comes from -e/--regexp", () => {
    expect(validateSafeBinArgv(["-e", "SECRET", ".env"], grepProfile)).toBe(false);
    expect(validateSafeBinArgv(["--regexp", "KEY", "config.py"], grepProfile)).toBe(false);
    expect(validateSafeBinArgv(["--regexp=KEY", ".env"], grepProfile)).toBe(false);
    expect(validateSafeBinArgv(["-e", "KEY", "--", ".env"], grepProfile)).toBe(false);
  });
});

describe("exec safe bin policy jq", () => {
  const jqProfile = expectDefined(SAFE_BIN_PROFILES.jq, "SAFE_BIN_PROFILES.jq test invariant");

  it("blocks normal jq field filters in safe-bin mode", () => {
    expect(validateSafeBinArgv([".foo"], jqProfile, { binName: "jq" })).toBe(false);
    expect(validateSafeBinArgv([".env"], jqProfile, { binName: "jq" })).toBe(false);
  });

  it("blocks jq env builtin filters in safe-bin mode", () => {
    expect(validateSafeBinArgv(["env"], jqProfile, { binName: "jq" })).toBe(false);
    expect(validateSafeBinArgv(["env.FOO"], jqProfile, { binName: "jq" })).toBe(false);
    expect(validateSafeBinArgv([".foo | env"], jqProfile, { binName: "jq" })).toBe(false);
    expect(validateSafeBinArgv(["$ENV"], jqProfile, { binName: "jq" })).toBe(false);
    expect(validateSafeBinArgv(["($ENV).OPENAI_API_KEY"], jqProfile, { binName: "jq" })).toBe(
      false,
    );
  });
});

describe("exec safe bin policy sort", () => {
  const sortProfile = expectDefined(
    SAFE_BIN_PROFILES.sort,
    "SAFE_BIN_PROFILES.sort test invariant",
  );

  it("allows stdin-only sort flags", () => {
    expect(validateSafeBinArgv(["-S", "1M"], sortProfile)).toBe(true);
    expect(validateSafeBinArgv(["--key=1,1"], sortProfile)).toBe(true);
    expect(validateSafeBinArgv(["--ke=1,1"], sortProfile)).toBe(true);
  });

  it("rejects missing or path-like values for allowed flags", () => {
    expect(validateSafeBinArgv(["--key"], sortProfile)).toBe(false);
    expect(validateSafeBinArgv(["--key", "./fields.txt"], sortProfile)).toBe(false);
    expect(validateSafeBinArgv(["-S", "C:\\temp\\buffer"], sortProfile)).toBe(false);
  });

  it("blocks sort --compress-program in safe-bin mode", () => {
    expect(validateSafeBinArgv(["--compress-program=sh"], sortProfile)).toBe(false);
    expect(validateSafeBinArgv(["--compress-program", "sh"], sortProfile)).toBe(false);
  });

  it("blocks denied long-option abbreviations in safe-bin mode", () => {
    expect(validateSafeBinArgv(["--compress-prog=sh"], sortProfile)).toBe(false);
    expect(validateSafeBinArgv(["--files0-fro=list.txt"], sortProfile)).toBe(false);
  });

  it("rejects unknown or ambiguous long options in safe-bin mode", () => {
    expect(validateSafeBinArgv(["--totally-unknown=1"], sortProfile)).toBe(false);
    expect(validateSafeBinArgv(["--f=1"], sortProfile)).toBe(false);
  });
});

describe("exec safe bin policy wc", () => {
  const wcProfile = expectDefined(SAFE_BIN_PROFILES.wc, "SAFE_BIN_PROFILES.wc test invariant");

  it("blocks wc --files0-from abbreviations in safe-bin mode", () => {
    expect(validateSafeBinArgv(["--files0-fro=list.txt"], wcProfile)).toBe(false);
    expect(validateSafeBinArgv(["--files0-fro", "list.txt"], wcProfile)).toBe(false);
  });
});

describe("exec safe bin policy boolean flags", () => {
  it("accepts recognized read-only boolean short flags on default safe bins", () => {
    expect(
      validateSafeBinArgv(
        ["-l"],
        expectDefined(SAFE_BIN_PROFILES.wc, "SAFE_BIN_PROFILES.wc test invariant"),
      ),
    ).toBe(true);
    expect(
      validateSafeBinArgv(
        ["-w"],
        expectDefined(SAFE_BIN_PROFILES.wc, "SAFE_BIN_PROFILES.wc test invariant"),
      ),
    ).toBe(true);
    expect(
      validateSafeBinArgv(
        ["-lw"],
        expectDefined(SAFE_BIN_PROFILES.wc, "SAFE_BIN_PROFILES.wc test invariant"),
      ),
    ).toBe(true);
    expect(
      validateSafeBinArgv(
        ["-c"],
        expectDefined(SAFE_BIN_PROFILES.uniq, "SAFE_BIN_PROFILES.uniq test invariant"),
      ),
    ).toBe(true);
    expect(
      validateSafeBinArgv(
        ["-d", "abc"],
        expectDefined(SAFE_BIN_PROFILES.tr, "SAFE_BIN_PROFILES.tr test invariant"),
      ),
    ).toBe(true);
    expect(
      validateSafeBinArgv(
        ["-s", "abc"],
        expectDefined(SAFE_BIN_PROFILES.tr, "SAFE_BIN_PROFILES.tr test invariant"),
      ),
    ).toBe(true);
  });

  it("accepts recognized boolean long flags and their abbreviations", () => {
    expect(
      validateSafeBinArgv(
        ["--lines"],
        expectDefined(SAFE_BIN_PROFILES.wc, "SAFE_BIN_PROFILES.wc test invariant"),
      ),
    ).toBe(true);
    expect(
      validateSafeBinArgv(
        ["--max-line-length"],
        expectDefined(SAFE_BIN_PROFILES.wc, "SAFE_BIN_PROFILES.wc test invariant"),
      ),
    ).toBe(true);
    expect(
      validateSafeBinArgv(
        ["--word"],
        expectDefined(SAFE_BIN_PROFILES.wc, "SAFE_BIN_PROFILES.wc test invariant"),
      ),
    ).toBe(true);
  });

  it("still rejects a value attached to a boolean flag", () => {
    expect(
      validateSafeBinArgv(
        ["--lines=5"],
        expectDefined(SAFE_BIN_PROFILES.wc, "SAFE_BIN_PROFILES.wc test invariant"),
      ),
    ).toBe(false);
  });

  it("still rejects unrecognized short flags", () => {
    expect(
      validateSafeBinArgv(
        ["-S", "a", "b"],
        expectDefined(SAFE_BIN_PROFILES.tr, "SAFE_BIN_PROFILES.tr test invariant"),
      ),
    ).toBe(false);
    expect(
      validateSafeBinArgv(
        ["-Z"],
        expectDefined(SAFE_BIN_PROFILES.wc, "SAFE_BIN_PROFILES.wc test invariant"),
      ),
    ).toBe(false);
  });

  it("keeps tail -fn 1 follow mode fail-closed", () => {
    expect(
      validateSafeBinArgv(
        ["-fn", "1"],
        expectDefined(SAFE_BIN_PROFILES.tail, "SAFE_BIN_PROFILES.tail test invariant"),
      ),
    ).toBe(false);
  });

  it("keeps mixed boolean+value short clusters working", () => {
    expect(
      validateSafeBinArgv(
        ["-cf", "2"],
        expectDefined(SAFE_BIN_PROFILES.uniq, "SAFE_BIN_PROFILES.uniq test invariant"),
      ),
    ).toBe(true);
  });

  it("keeps allowedBooleanFlags on built-in default profiles", () => {
    expect(
      expectDefined(
        SAFE_BIN_PROFILES.wc,
        "SAFE_BIN_PROFILES.wc test invariant",
      ).allowedBooleanFlags?.has("-l"),
    ).toBe(true);
    expect(
      validateSafeBinArgv(
        ["-l"],
        expectDefined(SAFE_BIN_PROFILES.wc, "SAFE_BIN_PROFILES.wc test invariant"),
      ),
    ).toBe(true);
  });

  it("does not let custom config profiles widen the boolean allowlist", () => {
    const customFixtures = {
      wc: { allowedBooleanFlags: ["-l"], deniedFlags: ["--files0-from"] },
    } as unknown as SafeBinProfileFixtures;
    const normalized = normalizeSafeBinProfileFixtures(customFixtures);
    expect(
      "allowedBooleanFlags" in expectDefined(normalized.wc, "normalized.wc test invariant"),
    ).toBe(false);
    const profiles = resolveSafeBinProfiles(customFixtures);
    expect(
      expectDefined(profiles.wc, "profiles.wc test invariant").allowedBooleanFlags?.size ?? 0,
    ).toBe(0);
    expect(
      validateSafeBinArgv(["-l"], expectDefined(profiles.wc, "profiles.wc test invariant")),
    ).toBe(false);
  });
});

describe("exec safe bin policy token hygiene", () => {
  it("rejects path-like and glob positional tokens after the terminator", () => {
    const grepProfile = expectDefined(
      SAFE_BIN_PROFILES.grep,
      "SAFE_BIN_PROFILES.grep test invariant",
    );
    expect(validateSafeBinArgv(["-e", "needle", "--", "../secret.txt"], grepProfile)).toBe(false);
    expect(validateSafeBinArgv(["-e", "needle", "--", "*.txt"], grepProfile)).toBe(false);
  });

  it("keeps stdin marker after the terminator non-positional", () => {
    const grepProfile = expectDefined(
      SAFE_BIN_PROFILES.grep,
      "SAFE_BIN_PROFILES.grep test invariant",
    );
    expect(validateSafeBinArgv(["-e", "needle", "--", "-"], grepProfile)).toBe(true);
  });
});

describe("exec safe bin policy long-option metadata", () => {
  it("precomputes long-option prefix mappings for compiled profiles", () => {
    const sortProfile = expectDefined(
      SAFE_BIN_PROFILES.sort,
      "SAFE_BIN_PROFILES.sort test invariant",
    );
    expect(sortProfile.knownLongFlagsSet?.has("--compress-program")).toBe(true);
    expect(sortProfile.longFlagPrefixMap?.get("--compress-prog")).toBe("--compress-program");
    expect(sortProfile.longFlagPrefixMap?.get("--f")).toBe(null);
  });

  it("preserves behavior when profile metadata is missing and rebuilt at runtime", () => {
    const sortProfile = SAFE_BIN_PROFILES.sort;
    const withoutMetadata = {
      ...sortProfile,
      knownLongFlags: undefined,
      knownLongFlagsSet: undefined,
      longFlagPrefixMap: undefined,
    };
    expect(validateSafeBinArgv(["--compress-prog=sh"], withoutMetadata)).toBe(false);
    expect(validateSafeBinArgv(["--totally-unknown=1"], withoutMetadata)).toBe(false);
  });

  it("builds prefix maps from collected long flags", () => {
    const sortProfile = expectDefined(
      SAFE_BIN_PROFILES.sort,
      "SAFE_BIN_PROFILES.sort test invariant",
    );
    const flags = collectKnownLongFlags(
      sortProfile.allowedValueFlags ?? new Set(),
      sortProfile.deniedFlags ?? new Set(),
    );
    const prefixMap = buildLongFlagPrefixMap(flags);
    expect(prefixMap.get("--compress-pr")).toBe("--compress-program");
    expect(prefixMap.get("--f")).toBe(null);
  });
});

describe("exec safe bin policy denied-flag matrix", () => {
  for (const [binName, fixture] of Object.entries(SAFE_BIN_PROFILE_FIXTURES)) {
    const profile = expectDefined(
      SAFE_BIN_PROFILES[binName],
      "SAFE_BIN_PROFILES[binName] test invariant",
    );
    const deniedFlags = fixture.deniedFlags ?? [];
    for (const deniedFlag of deniedFlags) {
      const variants = buildDeniedFlagArgvVariants(deniedFlag);
      for (const variant of variants) {
        it(`${binName} denies ${deniedFlag} (${variant.join(" ")})`, () => {
          expect(validateSafeBinArgv(variant, profile)).toBe(false);
        });
      }
    }
  }
});

describe("exec safe bin policy docs parity", () => {
  it("keeps default safe-bin docs in sync with policy defaults", () => {
    const docsPath = path.resolve(process.cwd(), SAFE_BIN_DOC_PATH);
    const docs = fs.readFileSync(docsPath, "utf8").replaceAll("\r\n", "\n");
    const start = docs.indexOf(SAFE_BIN_DOC_DEFAULTS_START);
    const end = docs.indexOf(SAFE_BIN_DOC_DEFAULTS_END);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const actual = docs.slice(start + SAFE_BIN_DOC_DEFAULTS_START.length, end).trim();
    const expected = renderDefaultSafeBinsDocText(DEFAULT_SAFE_BINS);
    expect(actual).toBe(expected);
  });

  it("keeps denied-flag docs in sync with policy fixtures", () => {
    const docsPath = path.resolve(process.cwd(), SAFE_BIN_DOC_PATH);
    const docs = fs.readFileSync(docsPath, "utf8").replaceAll("\r\n", "\n");
    const start = docs.indexOf(SAFE_BIN_DOC_DENIED_FLAGS_START);
    const end = docs.indexOf(SAFE_BIN_DOC_DENIED_FLAGS_END);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const actual = normalizeGeneratedDocBlock(
      docs.slice(start + SAFE_BIN_DOC_DENIED_FLAGS_START.length, end),
    );
    const expected = renderSafeBinDeniedFlagsDocBullets();
    expect(actual).toBe(expected);
  });
});
