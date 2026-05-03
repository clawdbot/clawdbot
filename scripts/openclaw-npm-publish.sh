#!/usr/bin/env bash

set -euo pipefail

mode="${1:-}"
publish_target="${2:-}"

if [[ "${mode}" != "--publish" ]]; then
  echo "usage: bash scripts/openclaw-npm-publish.sh --publish [package.tgz]" >&2
  exit 2
fi

if [[ -n "${publish_target}" && -f "${publish_target}" ]]; then
  case "${publish_target}" in
    /*|./*|../*) ;;
    *) publish_target="./${publish_target}" ;;
  esac
fi

package_version="$(node -p "require('./package.json').version")"
mapfile -t publish_plan < <(
  PACKAGE_VERSION="${package_version}" REQUESTED_PUBLISH_TAG="${OPENCLAW_NPM_PUBLISH_TAG:-}" \
    node --import tsx --input-type=module <<'EOF'
import { resolveNpmPublishPlan } from "./scripts/openclaw-npm-release-check.ts";

const requestedPublishTag =
  process.env.REQUESTED_PUBLISH_TAG === "latest"
    ? "latest"
    : process.env.REQUESTED_PUBLISH_TAG === "alpha"
      ? "alpha"
      : "beta";
const plan = resolveNpmPublishPlan(process.env.PACKAGE_VERSION ?? "", undefined, requestedPublishTag);
console.log(plan.channel);
console.log(plan.publishTag);
EOF
)

release_channel="${publish_plan[0]}"
publish_tag="${publish_plan[1]}"
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
