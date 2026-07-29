// Covers safe-bin policy profiles, validation, and generated docs text.
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SAFE_BINS,
  SAFE_BIN_PROFILES,
  normalizeSafeBinProfileFixtures,
  resolveSafeBinProfiles,
  type SafeBinProfileFixtures,
  validateSafeBinArgv,
} from "./exec-safe-bin-policy.js";

const SAFE_BIN_DOC_DEFAULTS_START = '[//]: # "SAFE_BIN_DEFAULTS:START"';
const SAFE_BIN_DOC_DEFAULTS_END = '[//]: # "SAFE_BIN_DEFAULTS:END"';
const SAFE_BIN_DOC_DENIED_FLAGS_START = '[//]: # "SAFE_BIN_DENIED_FLAGS:START"';
const SAFE_BIN_DOC_DENIED_FLAGS_END = '[//]: # "SAFE_BIN_DENIED_FLAGS:END"';
const SAFE_BIN_DOC_PATH = "docs/tools/exec-approvals-advanced.md";

function readGeneratedDocBlock(startMarker: string, endMarker: string): string {
  const docs = fs.readFileSync(path.resolve(process.cwd(), SAFE_BIN_DOC_PATH), "utf8");
  const start = docs.indexOf(startMarker);
  const end = docs.indexOf(endMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return docs.slice(start + startMarker.length, end).trim();
}

function buildDeniedFlagArgvVariants(flag: string): string[][] {
  if (flag.startsWith("--")) {
    return [[`${flag}=blocked`], [flag, "blocked"], [flag]];
  }
  if (flag.startsWith("-")) {
    return [[`${flag}blocked`], [flag, "blocked"], [flag]];
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
});

describe("exec safe bin policy denied-flag matrix", () => {
  for (const [binName, profile] of Object.entries(SAFE_BIN_PROFILES)) {
    for (const deniedFlag of profile.deniedFlags ?? []) {
      for (const variant of buildDeniedFlagArgvVariants(deniedFlag)) {
        it(`${binName} denies ${deniedFlag} (${variant.join(" ")})`, () => {
          expect(validateSafeBinArgv(variant, profile, { binName })).toBe(false);
        });
      }
    }
  }
});

describe("exec safe bin policy docs parity", () => {
  it("keeps default safe-bin docs in sync with policy defaults", () => {
    const actual = readGeneratedDocBlock(SAFE_BIN_DOC_DEFAULTS_START, SAFE_BIN_DOC_DEFAULTS_END);
    const expected = DEFAULT_SAFE_BINS.map((bin) => `\`${bin}\``).join(", ");
    expect(actual).toBe(expected);
  });

  it("keeps denied-flag docs in sync with compiled policy profiles", () => {
    const actual = readGeneratedDocBlock(
      SAFE_BIN_DOC_DENIED_FLAGS_START,
      SAFE_BIN_DOC_DENIED_FLAGS_END,
    );
    const expected = Object.entries(SAFE_BIN_PROFILES)
      .flatMap(([bin, profile]) => {
        const deniedFlags = Array.from(profile.deniedFlags ?? []).toSorted();
        return deniedFlags.length === 0
          ? []
          : [`- \`${bin}\`: ${deniedFlags.map((flag) => `\`${flag}\``).join(", ")}`];
      })
      .toSorted()
      .join("\n");
    expect(actual).toBe(expected);
  });
});
