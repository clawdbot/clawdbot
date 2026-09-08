import {
  classifyReleaseTrain,
  parseReleaseVersion,
  resolveReleaseTagPackageIdentity,
} from "./release-version.mjs";

export function parseReleaseContextRef(contextRef) {
  const ref = contextRef.replace(/^refs\/(?:heads|tags)\//u, "");
  const kind = ref.startsWith("release/")
    ? "release branch"
    : ref.startsWith("extended-stable/")
      ? "extended-stable branch"
      : ref.startsWith("v")
        ? "release tag"
        : null;
  if (
    !kind ||
    (contextRef !== ref &&
      contextRef !== `refs/${kind === "release tag" ? "tags" : "heads"}/${ref}`)
  ) {
    return null;
  }
  const rawVersion = kind === "release tag" ? ref.slice(1) : ref.slice(ref.indexOf("/") + 1);
  const version = parseReleaseVersion(rawVersion);
  if (
    !version ||
    version.version !== rawVersion ||
    classifyReleaseTrain(version) === "unsupported-extended-stable-correction" ||
    (kind !== "release tag" && version.channel !== "stable") ||
    (kind === "extended-stable branch" && version.patch !== 33)
  ) {
    return null;
  }
  return { kind, ref, version };
}

export function releaseBranchForTag(tag) {
  const context = parseReleaseContextRef(tag);
  if (!context || context.kind !== "release tag" || context.version.channel === "alpha") {
    return "";
  }
  const version =
    context.version.channel === "beta" ? context.version.baseVersion : context.version.version;
  return `release/${version}`;
}

export function resolveReleaseContextIdentity(contextRef, packageVersion) {
  const context = parseReleaseContextRef(contextRef);
  if (!context) {
    return null;
  }
  const packaged = parseReleaseVersion(packageVersion);
  let releaseTag = `v${packageVersion}`;
  if (context.kind === "extended-stable branch") {
    if (
      !packaged ||
      classifyReleaseTrain(packaged) !== "extended-stable" ||
      packaged.year !== context.version.year ||
      packaged.month !== context.version.month
    ) {
      throw new Error(
        `Target package version ${packageVersion} does not belong to extended-stable branch ${context.ref}; expected a final ${context.version.year}.${context.version.month}.PATCH version with PATCH >= 33.`,
      );
    }
  } else if (context.kind === "release branch" && context.version.correctionNumber === undefined) {
    if (
      !packaged ||
      (packageVersion !== context.version.version &&
        !(packaged.channel === "beta" && packaged.baseVersion === context.version.version))
    ) {
      throw new Error(
        `Target package version ${packageVersion} does not belong to release branch ${context.ref}; expected ${context.version.version} or a beta prerelease of it.`,
      );
    }
  } else {
    releaseTag = `v${context.version.version}`;
  }
  return { kind: context.kind, ...resolveReleaseTagPackageIdentity(releaseTag, packageVersion) };
}
