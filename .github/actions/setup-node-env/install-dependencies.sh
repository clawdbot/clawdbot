#!/usr/bin/env bash

set -euo pipefail
export PATH="$NODE_BIN:$PATH"
which node
node -v
pnpm -v
case "$FROZEN_LOCKFILE" in
  true) LOCKFILE_FLAG="--frozen-lockfile" ;;
  false) LOCKFILE_FLAG="" ;;
  *)
    echo "::error::Invalid frozen-lockfile input: '$FROZEN_LOCKFILE' (expected true or false)"
    exit 2
    ;;
esac

install_args=(
  install
  --config.ignore-scripts=false
  --config.engine-strict=false
  --config.enable-pre-post-scripts=true
  --config.side-effects-cache=true
)
if [ "$DEPENDENCY_CACHE" = "true" ]; then
  # Both trees live below the workspace. Prefer real hard links so the
  # single cache archive can preserve store/package identity; pnpm
  # safely falls back to copies for files it cannot hard-link.
  export PNPM_CONFIG_PACKAGE_IMPORT_METHOD=hardlink
fi
if [ -n "$LOCKFILE_FLAG" ]; then
  install_args+=("$LOCKFILE_FLAG")
fi
# Native pnpm reads these env settings; config flags also support older checkouts.
append_pnpm_option_arg() {
  local env_name="$1"
  local option_name="$2"
  local value="${!env_name-}"
  if [ -n "$value" ]; then
    install_args+=("--config.${option_name}=${value}")
  fi
}
append_pnpm_option_arg PNPM_CONFIG_CACHE_DIR cache-dir
append_pnpm_option_arg PNPM_CONFIG_CHILD_CONCURRENCY child-concurrency
append_pnpm_option_arg PNPM_CONFIG_MODULES_DIR modules-dir
append_pnpm_option_arg PNPM_CONFIG_NETWORK_CONCURRENCY network-concurrency
append_pnpm_option_arg PNPM_CONFIG_PACKAGE_IMPORT_METHOD package-import-method
append_pnpm_option_arg PNPM_CONFIG_STORE_DIR store-dir
append_pnpm_option_arg PNPM_CONFIG_VIRTUAL_STORE_DIR virtual-store-dir
run_pnpm_install() {
  local fetch_mode="$1"
  pnpm "${install_args[@]}" "$fetch_mode"
}
clear_dependency_modules() {
  rm -rf "$GITHUB_WORKSPACE/node_modules"
  find \
    "$GITHUB_WORKSPACE/ui" \
    "$GITHUB_WORKSPACE/packages" \
    "$GITHUB_WORKSPACE/extensions" \
    "$GITHUB_WORKSPACE/examples" \
    -mindepth 1 -maxdepth 2 \( -type d -o -type l \) -name node_modules \
    -exec rm -rf -- {} +
}
if [ -n "${PNPM_CONFIG_MODULES_DIR:-}" ]; then
  mkdir -p "$PNPM_CONFIG_MODULES_DIR"
  ln -sfn . "$PNPM_CONFIG_MODULES_DIR/node_modules"
  export NODE_PATH="$PNPM_CONFIG_MODULES_DIR${NODE_PATH:+:$NODE_PATH}"
fi
install_status=0
if [ "$DEPENDENCY_CACHE_HIT" = "true" ]; then
  run_pnpm_install --offline || install_status="$?"
else
  run_pnpm_install --prefer-offline || install_status="$?"
fi
if [ "$install_status" -ne 0 ] && [ "$DEPENDENCY_CACHE_HIT" = "true" ]; then
  echo "::warning::Cached dependency tree failed pnpm reconciliation; relinking it from the restored store"
  clear_dependency_modules
  install_status=0
  run_pnpm_install --offline || install_status="$?"
fi
if [ "$install_status" -ne 0 ] && [ "$DEPENDENCY_CACHE_HIT" = "true" ]; then
  echo "::warning::Restored dependency store failed pnpm reconciliation; retrying from an empty store"
  clear_dependency_modules
  rm -rf "${PNPM_CONFIG_STORE_DIR:?}"
  install_status=0
  run_pnpm_install --prefer-offline || install_status="$?"
fi
if [ "$install_status" -ne 0 ]; then
  echo "::error::pnpm install failed"
  exit "$install_status"
fi
if [ -n "${PNPM_CONFIG_MODULES_DIR:-}" ]; then
  rm -rf node_modules
  ln -sfn "$PNPM_CONFIG_MODULES_DIR" node_modules
  ln -sfn . "$PNPM_CONFIG_MODULES_DIR/node_modules"
fi

if [ "$DEPENDENCY_CACHE" = "true" ]; then
  # The exact archive includes importer links, and frozen offline
  # reconciliation validates them without reaching the registry. Later
  # build wrappers can use installed Node entrypoints directly.
  echo "OPENCLAW_BUILD_ALL_NO_PNPM=1" >> "$GITHUB_ENV"
  # Install and frozen reconciliation own dependency writes. Keep later
  # shard commands read-only so they cannot launch concurrent implicit
  # installs after CI fans out.
  # zizmor: ignore[github-env] static pnpm policy owned by this action.
  echo "pnpm_config_verify_deps_before_run=false" >> "$GITHUB_ENV"
fi
