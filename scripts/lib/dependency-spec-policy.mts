import { valid as validSemver } from "semver";

const NPM_ALIAS_PATTERN = /^npm:(?:@[^/@\s]+\/[^/@\s]+|[^/@\s]+)@(.+)$/u;
const PINNED_GIT_PATTERN =
  /^(?:git\+|github:|gitlab:|bitbucket:)[^#\s]+#[0-9a-f]{40}(?:&path:[^&\s]+)?$/iu;
const PINNED_GITHUB_TARBALL_PATTERN =
  /^https:\/\/codeload\.github\.com\/[^/\s]+\/[^/\s]+\/tar\.gz\/[0-9a-f]{40}$/iu;
const EXOTIC_SPEC_PATTERN = /^(?:git\+|git:|github:|gitlab:|bitbucket:|https?:|ssh:)/iu;
const SCP_GIT_PATTERN = /^[^@:/\s]+@[^/:\s]+:[^\s]+$/u;

function isExactRegistryVersion(spec: string): boolean {
  return /^\d/u.test(spec) && spec === spec.trim() && validSemver(spec) !== null;
}

export function classifyDependencySpec(
  spec: unknown,
): Readonly<{ allowedPinned: boolean; exotic: boolean }> {
  if (typeof spec !== "string") {
    return { allowedPinned: false, exotic: false };
  }
  const aliasVersion = NPM_ALIAS_PATTERN.exec(spec)?.[1];
  const pinnedGit = PINNED_GIT_PATTERN.test(spec);
  const pinnedTarball = PINNED_GITHUB_TARBALL_PATTERN.test(spec);
  return {
    allowedPinned:
      isExactRegistryVersion(spec) ||
      (aliasVersion !== undefined && isExactRegistryVersion(aliasVersion)) ||
      spec === "workspace:*" ||
      ((spec.startsWith("file:") || spec.startsWith("link:")) && /\S/u.test(spec.slice(5))) ||
      pinnedGit ||
      pinnedTarball,
    exotic: EXOTIC_SPEC_PATTERN.test(spec) || SCP_GIT_PATTERN.test(spec),
  };
}
