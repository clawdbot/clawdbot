import { LOCAL_BUILD_METADATA_DIST_PATHS } from "./local-build-metadata-paths.mts";

const FORBIDDEN_PACKED_PATH_RULES = [
  ...LOCAL_BUILD_METADATA_DIST_PATHS.map((prefix) => ({
    prefix,
    describe: (packedPath: string) =>
      `npm package must not include local build metadata "${packedPath}".`,
  })),
  {
    prefix: "dist-runtime/",
    describe: (packedPath: string) =>
      `npm package must not include local runtime build output "${packedPath}".`,
  },
  {
    prefix: "dist/OpenClaw.app/",
    describe: (packedPath: string) =>
      `npm package must not include local application build output "${packedPath}".`,
  },
  {
    prefix: "docs/.generated/",
    describe: (packedPath: string) =>
      `npm package must not include generated docs artifact "${packedPath}".`,
  },
  {
    prefix: "docs/channels/qa-channel.md",
    describe: (packedPath: string) =>
      `npm package must not include private QA channel docs "${packedPath}".`,
  },
  {
    prefix: "dist/extensions/qa-channel/",
    describe: (packedPath: string) =>
      `npm package must not include private QA channel artifact "${packedPath}".`,
  },
  {
    prefix: "dist/extensions/qa-lab/",
    describe: (packedPath: string) =>
      `npm package must not include private QA lab artifact "${packedPath}".`,
  },
  {
    prefix: "dist/plugin-sdk/extensions/qa-channel/",
    describe: (packedPath: string) =>
      `npm package must not include private QA channel type artifact "${packedPath}".`,
  },
  {
    prefix: "dist/plugin-sdk/extensions/qa-lab/",
    describe: (packedPath: string) =>
      `npm package must not include private QA lab type artifact "${packedPath}".`,
  },
  {
    prefix: "dist/plugin-sdk/qa-channel.",
    describe: (packedPath: string) =>
      `npm package must not include private QA channel SDK artifact "${packedPath}".`,
  },
  {
    prefix: "dist/plugin-sdk/qa-channel-protocol.",
    describe: (packedPath: string) =>
      `npm package must not include private QA channel SDK artifact "${packedPath}".`,
  },
  {
    prefix: "dist/plugin-sdk/qa-lab.",
    describe: (packedPath: string) =>
      `npm package must not include private QA lab SDK artifact "${packedPath}".`,
  },
  {
    prefix: "dist/plugin-sdk/qa-runtime.",
    describe: (packedPath: string) =>
      `npm package must not include private QA runtime SDK artifact "${packedPath}".`,
  },
  {
    prefix: "dist/qa-runtime-",
    describe: (packedPath: string) =>
      `npm package must not include private QA runtime chunk "${packedPath}".`,
  },
  {
    prefix: "qa/",
    describe: (packedPath: string) =>
      `npm package must not include private QA suite artifact "${packedPath}".`,
  },
] as const;

export function collectForbiddenPackedPathErrors(paths: Iterable<string>): string[] {
  const errors: string[] = [];
  for (const packedPath of paths) {
    const matchedRule = FORBIDDEN_PACKED_PATH_RULES.find((rule) =>
      packedPath.startsWith(rule.prefix),
    );
    if (matchedRule) {
      errors.push(matchedRule.describe(packedPath));
    }
  }
  return errors.toSorted((left, right) => left.localeCompare(right));
}
