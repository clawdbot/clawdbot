#!/usr/bin/env bash

set -euo pipefail

clawhub_cli="${1:?locked ClawHub CLI path is required}"
help_output="$(
  "${clawhub_cli}" package trusted-publisher set --help 2>&1 || true
)"
printf '%s\n' "${help_output}"

if ! grep -Fq "Usage: clawhub package trusted-publisher set" <<<"${help_output}"; then
  echo "::error::The locked ClawHub CLI must expose 'package trusted-publisher set' before trusted plugin publishing can run."
  exit 1
fi

for required_flag in --repository --workflow-filename; do
  if ! grep -Fq -- "${required_flag}" <<<"${help_output}"; then
    echo "::error::The locked ClawHub CLI trusted-publisher command must include ${required_flag}."
    exit 1
  fi
done
