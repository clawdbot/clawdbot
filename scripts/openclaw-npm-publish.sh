#!/usr/bin/env bash

set -euo pipefail

usage() {
  echo "usage: bash scripts/openclaw-npm-publish.sh --publish [package.tgz]"
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if [[ "${1:-}" != "--publish" ]]; then
  usage >&2
  exit 2
fi
shift

publish_target=""
if [[ "${1:-}" == "--" ]]; then
  shift
fi
if [[ "$#" -gt 0 ]]; then
  case "$1" in
    -*) echo "error: unexpected npm publish target option: $1" >&2; exit 2 ;;
    *) publish_target="$1"; shift ;;
  esac
fi
if [[ "$#" -gt 0 ]]; then
  echo "error: unexpected npm publish argument: $1" >&2
  exit 2
fi

if [[ -n "${publish_target}" && -f "${publish_target}" ]]; then
  case "${publish_target}" in
    /*|./*|../*) ;;
    *) publish_target="./${publish_target}" ;;
  esac
fi

package_version="$(node -p "require('./package.json').version")"
if [[ -n "${publish_target}" ]]; then
  if [[ ! -f "${publish_target}" ]]; then
    echo "error: npm publish tarball not found: ${publish_target}" >&2
    exit 2
  fi
  if ! tarball_package_json="$(tar -xOf "${publish_target}" package/package.json)"; then
    echo "error: npm publish tarball is missing a readable package/package.json: ${publish_target}" >&2
    exit 2
  fi
  if ! tarball_package_version="$(printf '%s' "${tarball_package_json}" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const pkg = JSON.parse(input);
      if (!pkg || typeof pkg !== "object" || Array.isArray(pkg) || typeof pkg.version !== "string" || pkg.version.trim() === "") {
        throw new Error("package/package.json must contain a nonempty string version");
      }
      process.stdout.write(pkg.version.trim());
    });
  ')"; then
    echo "error: npm publish tarball package/package.json is malformed or has no valid version: ${publish_target}" >&2
    exit 2
  fi
  if [[ "${tarball_package_version}" != "${package_version}" ]]; then
    echo "error: npm publish tarball version mismatch: expected ${package_version}, got ${tarball_package_version}" >&2
    exit 2
  fi
fi

publish_plan="$(
  PACKAGE_VERSION="${package_version}" REQUESTED_PUBLISH_TAG="${OPENCLAW_NPM_PUBLISH_TAG:-}" \
    BYPASS_EXTENDED_STABLE_GUARD="${BYPASS_EXTENDED_STABLE_GUARD:-}" \
    node scripts/openclaw-npm-extended-stable-release.mjs publish-plan
)"

release_channel="${publish_plan%%$'\n'*}"
publish_tag="${publish_plan#*$'\n'}"
publish_cmd=(npm publish)
if [[ -n "${publish_target}" ]]; then
  publish_cmd+=("${publish_target}")
fi
publish_cmd+=(--access public --tag "${publish_tag}" --provenance)

echo "Resolved package version: ${package_version}"
echo "Resolved release channel: ${release_channel}"
echo "Resolved publish tag: ${publish_tag}"
echo "Publish auth: GitHub OIDC trusted publishing"
if [[ -n "${publish_target}" ]]; then
  echo "Resolved publish target: ${publish_target}"
fi

printf 'Publish command:'
printf ' %q' "${publish_cmd[@]}"
printf '\n'

"${publish_cmd[@]}"
