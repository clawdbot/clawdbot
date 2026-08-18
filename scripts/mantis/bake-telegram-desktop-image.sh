#!/usr/bin/env bash
set -euo pipefail

telegram_version="7.0.9"
telegram_url="https://github.com/telegramdesktop/tdesktop/releases/download/v7.0.9/tsetup.7.0.9.tar.xz"
telegram_sha256="d3c05df0259ab116d11d8c1cdc1403019d2a3be303ad3b46d16a84e19df6615f"
variant_sdk="telegram-desktop=${telegram_version}"

region="eu-west-1"
server_class="standard"
server_type=""
image_name=""
output_file=""
crabbox_bin="crabbox"
run=0
promote=1
keep_lease=0

usage() {
  cat <<'USAGE'
Usage: scripts/mantis/bake-telegram-desktop-image.sh [flags]

Bake and optionally publish the catalog-only Telegram Desktop Crabbox image.
By default this prints the plan and exits. Add --run to create paid AWS
leases and an AMI.

Flags:
  --region REGION       AWS region. Default: eu-west-1.
  --class CLASS         Crabbox class. Default: standard.
  --type TYPE           Optional AWS instance type.
  --name NAME           Image name. Default: openclaw-telegram-desktop-<UTC timestamp>.
  --output FILE         JSON summary path. Default: .artifacts/mantis/telegram-desktop-image/<name>.json.
  --run                 Create leases and the AMI.
  --no-promote          Smoke the candidate without publishing it.
  --keep-lease          Keep every lease created by this run.
  --crabbox-bin PATH    Crabbox executable. Default: crabbox from PATH.
  -h, --help            Show this help.

Required with --run:
  Crabbox coordinator admin: run from a crabbox login listed in the
  coordinator's CRABBOX_GITHUB_ADMIN_OWNERS, or set CRABBOX_COORDINATOR plus
  CRABBOX_COORDINATOR_ADMIN_TOKEN for headless use. Image create/promote are
  admin-only; the script probes for admin before paying for any lease.

Optional coordinator access:
  CRABBOX_ACCESS_CLIENT_ID
  CRABBOX_ACCESS_CLIENT_SECRET
USAGE
}

require_value() {
  local value="${2:-}"
  if [[ -z "$value" || "$value" == --* ]]; then
    printf '%s requires a value\n' "$1" >&2
    exit 2
  fi
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --region)
      require_value "$@"
      region="$2"
      shift 2
      ;;
    --class)
      require_value "$@"
      server_class="$2"
      shift 2
      ;;
    --type)
      require_value "$@"
      server_type="$2"
      shift 2
      ;;
    --name)
      require_value "$@"
      image_name="$2"
      shift 2
      ;;
    --output)
      require_value "$@"
      output_file="$2"
      shift 2
      ;;
    --run)
      run=1
      shift
      ;;
    --no-promote)
      promote=0
      shift
      ;;
    --keep-lease)
      keep_lease=1
      shift
      ;;
    --crabbox-bin)
      require_value "$@"
      crabbox_bin="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$image_name" ]]; then
  image_name="openclaw-telegram-desktop-$(date -u +%Y%m%d-%H%M)"
fi
if [[ -z "$output_file" ]]; then
  output_file=".artifacts/mantis/telegram-desktop-image/${image_name}.json"
fi

cat <<EOF
Telegram Desktop image bake
  image:       $image_name
  region:      $region
  class:       $server_class
  type:        ${server_type:-auto}
  version:     $telegram_version
  promote:     $promote
  keep leases: $keep_lease
  output:      $output_file
  paid run:    $run
EOF

if [[ "$run" != "1" ]]; then
  printf 'dry plan only; add --run to create leases and an AMI.\n'
  exit 0
fi

if ! crabbox_resolved="$(command -v "$crabbox_bin")"; then
  printf 'Crabbox executable not found: %s\n' "$crabbox_bin" >&2
  exit 2
fi
# Admin probe before any paid lease. image create/promote are admin-only. The
# probe asks the coordinator about a non-existent AMI: only an admin login gets
# through to the coordinator, which answers "not found"; a non-admin login is
# refused by the CLI before any request. Anything else (outage, auth, contract
# drift) fails closed rather than paying for leases first.
admin_probe_status=0
admin_probe="$("$crabbox_resolved" image fsr-status ami-00000000000000000 --provider aws 2>&1)" || admin_probe_status=$?
if [[ "$admin_probe_status" -eq 0 || "$admin_probe" == *"not found"* ]]; then
  :
elif [[ "$admin_probe" == *"admin command requires"* ]]; then
  printf 'Crabbox coordinator admin is required with --run (CRABBOX_GITHUB_ADMIN_OWNERS or CRABBOX_COORDINATOR_ADMIN_TOKEN).\n' >&2
  exit 2
else
  printf 'Could not verify Crabbox coordinator admin access; refusing to start paid leases. Probe output:\n%s\n' "$admin_probe" >&2
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  printf 'jq is required with --run.\n' >&2
  exit 2
fi

artifact_dir="$(dirname "$output_file")"
log_dir="$artifact_dir/logs"
mkdir -p "$log_dir"
prep_script="$(mktemp "${TMPDIR:-/tmp}/openclaw-telegram-image-prep.XXXXXX.sh")"
source_lease=""
candidate_lease=""
variant_lease=""
default_lease=""

cleanup() {
  local status=$?
  trap - EXIT
  rm -f "$prep_script"
  if [[ "$keep_lease" != "1" ]]; then
    local lease
    for lease in "$default_lease" "$variant_lease" "$candidate_lease" "$source_lease"; do
      [[ -n "$lease" ]] || continue
      "$crabbox_resolved" stop --provider aws --target linux "$lease" || true
    done
  fi
  exit "$status"
}
trap cleanup EXIT

cat >"$prep_script" <<PREP
#!/usr/bin/env bash
set -euo pipefail

telegram_version="$telegram_version"
telegram_url="$telegram_url"
telegram_sha256="$telegram_sha256"

if [[ "\$(id -u)" -ne 0 ]]; then
  if ! command -v sudo >/dev/null 2>&1; then
    printf 'sudo is required to prepare the Telegram Desktop image.\\n' >&2
    exit 2
  fi
  exec sudo -H env DEBIAN_FRONTEND=noninteractive bash "\$0"
fi

export DEBIAN_FRONTEND=noninteractive

retry() {
  local attempt=1
  until "\$@"; do
    if [[ "\$attempt" -ge 5 ]]; then
      return 1
    fi
    sleep "\$((attempt * 3))"
    attempt="\$((attempt + 1))"
  done
}

if [[ "\$(dpkg --print-architecture)" != "amd64" ]]; then
  printf 'Telegram Desktop image requires amd64.\\n' >&2
  exit 2
fi

retry apt-get update
retry apt-get install -y --no-install-recommends \
  x11-utils \
  zbar-tools \
  libopengl0 \
  libxcb-cursor0 \
  libxcb-icccm4 \
  libxcb-image0 \
  libxcb-keysyms1 \
  libxcb-randr0 \
  libxcb-render-util0 \
  libxcb-shape0 \
  libxcb-xfixes0 \
  libxcb-xinerama0 \
  libxkbcommon-x11-0

marker=/var/lib/crabbox/telegram-desktop-version
if [[ -x /opt/Telegram/Telegram && -f "\$marker" && "\$(<"\$marker")" == "\$telegram_version" ]]; then
  rm -f /opt/Telegram/Updater
  test -f /var/lib/crabbox/image-ready
  exit 0
fi

tmp_dir="\$(mktemp -d /tmp/telegram-desktop-install.XXXXXX)"
trap 'rm -rf "\$tmp_dir"' EXIT
archive="\$tmp_dir/telegram.tar.xz"
retry curl -fL --retry 5 --retry-all-errors -o "\$archive" "\$telegram_url"
printf '%s  %s\\n' "\$telegram_sha256" "\$archive" | sha256sum --check --status
tar -xJf "\$archive" -C "\$tmp_dir"
test -x "\$tmp_dir/Telegram/Telegram"

rm -rf /opt/Telegram
install -d -o root -g root -m 0755 /opt/Telegram
cp -a "\$tmp_dir/Telegram/." /opt/Telegram/
chown -R root:root /opt/Telegram
chmod 0755 /opt/Telegram /opt/Telegram/Telegram
rm -f /opt/Telegram/Updater
install -d -o root -g root -m 0755 /var/lib/crabbox
printf '%s\\n' "\$telegram_version" >"\$marker"
chmod 0644 "\$marker"
test -f /var/lib/crabbox/image-ready
PREP
chmod 0755 "$prep_script"

run_cmd() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
  "$@"
}

warmup() {
  local label="$1"
  local image_override="${2:-}"
  local image_selector="${3:-}"
  local log="$log_dir/${label}.log"
  local -a args=(
    warmup
    --provider aws
    --target linux
    --desktop
    --class "$server_class"
    --market on-demand
    --ttl 1h
    --idle-timeout 20m
    --timing-json
  )
  if [[ -n "$server_type" ]]; then
    args+=(--type "$server_type")
  fi
  if [[ -n "$image_selector" ]]; then
    args+=(--image-sdk "$image_selector")
  fi

  printf 'warming %s lease; log=%s\n' "$label" "$log" >&2
  local status=0
  if [[ -n "$image_override" ]]; then
    run_cmd env CRABBOX_AWS_REGION="$region" CRABBOX_AWS_AMI="$image_override" \
      "$crabbox_resolved" "${args[@]}" 2>&1 | tee "$log" >&2 || status=$?
  else
    run_cmd env CRABBOX_AWS_REGION="$region" \
      "$crabbox_resolved" "${args[@]}" 2>&1 | tee "$log" >&2 || status=$?
  fi
  local lease
  lease="$(grep -oE 'cbx_[A-Za-z0-9_-]+' "$log" | tail -n 1 || true)"
  if [[ "$status" -ne 0 ]]; then
    if [[ -n "$lease" && "$keep_lease" != "1" ]]; then
      "$crabbox_resolved" stop --provider aws --target linux "$lease" || true
    fi
    return "$status"
  fi
  if [[ -z "$lease" ]]; then
    printf 'warmup did not return a cbx lease id; log=%s\n' "$log" >&2
    return 1
  fi
  printf '%s\n' "$lease"
}

selected_image_id() {
  local log="$1"
  sed -nE 's/.*image selected id=([^[:space:]]+) source=[^[:space:]]+.*/\1/p' "$log" | tail -n 1
}

assert_selected_image() {
  local log="$1"
  local image_id="$2"
  local source="$3"
  if ! grep -Fq "image selected id=${image_id} source=${source}" "$log"; then
    printf 'warmup did not prove image selected id=%s source=%s; log=%s\n' \
      "$image_id" "$source" "$log" >&2
    return 1
  fi
}

smoke() {
  local lease="$1"
  local smoke_script
  read -r -d '' smoke_script <<'SMOKE' || true
set -euo pipefail
test -x /opt/Telegram/Telegram
test ! -e /opt/Telegram/Updater
test "$(</var/lib/crabbox/telegram-desktop-version)" = "7.0.9"
for tool in wmctrl xdotool scrot ffmpeg zbarimg xdpyinfo; do
  command -v "$tool" >/dev/null
done
DISPLAY=:99 xdpyinfo >/dev/null
rm -rf /tmp/tg-smoke
mkdir -p /tmp/tg-smoke
DISPLAY=:99 /opt/Telegram/Telegram -noupdate -workdir /tmp/tg-smoke >/tmp/tg-smoke.log 2>&1 &
telegram_pid=$!
cleanup_smoke() {
  kill "$telegram_pid" 2>/dev/null || true
  wait "$telegram_pid" 2>/dev/null || true
  rm -rf /tmp/tg-smoke /tmp/tg-smoke.log
}
trap cleanup_smoke EXIT
for _ in $(seq 1 30); do
  if DISPLAY=:99 wmctrl -lx | grep -Fq TelegramDesktop; then
    exit 0
  fi
  if ! kill -0 "$telegram_pid" 2>/dev/null; then
    printf 'Telegram Desktop exited before opening a window.\n' >&2
    exit 1
  fi
  sleep 1
done
printf 'TelegramDesktop window did not appear within 30 seconds.\n' >&2
exit 1
SMOKE
  run_cmd "$crabbox_resolved" run --provider aws --target linux --id "$lease" \
    --no-sync --shell -- "$smoke_script"
}

stop_lease() {
  local lease="$1"
  if [[ "$keep_lease" != "1" ]]; then
    run_cmd "$crabbox_resolved" stop --provider aws --target linux "$lease"
  fi
}

source_lease="$(warmup source)"
run_cmd "$crabbox_resolved" run --provider aws --target linux --id "$source_lease" \
  --no-sync --script "$prep_script"
smoke "$source_lease"

image_json="$log_dir/image-create.json"
env CRABBOX_AWS_REGION="$region" "$crabbox_resolved" image create \
  --id "$source_lease" --name "$image_name" --wait --json | tee "$image_json"
ami_id="$(jq -er '.id | select(type == "string" and startswith("ami-"))' "$image_json")"

if [[ "$keep_lease" != "1" ]]; then
  stop_lease "$source_lease"
  source_lease=""
fi

candidate_lease="$(warmup candidate "$ami_id")"
assert_selected_image "$log_dir/candidate.log" "$ami_id" explicit
smoke "$candidate_lease"
if [[ "$keep_lease" != "1" ]]; then
  stop_lease "$candidate_lease"
  candidate_lease=""
fi

promotion_status="skipped"
variant_selection="skipped"
variant_smoke="skipped"
default_unchanged="skipped"
if [[ "$promote" == "1" ]]; then
  promote_json="$log_dir/image-promote.json"
  env CRABBOX_AWS_REGION="$region" "$crabbox_resolved" image promote "$ami_id" \
    --provider aws --target linux --region "$region" --desktop \
    --catalog-only --variant-sdk "$variant_sdk" --json | tee "$promote_json"
  jq -e --arg ami "$ami_id" '.id == $ami and .catalogOnly == true' "$promote_json" >/dev/null
  promotion_status="catalog-only"

  variant_lease="$(warmup variant "" "$variant_sdk")"
  assert_selected_image "$log_dir/variant.log" "$ami_id" promoted
  variant_selection="promoted"
  smoke "$variant_lease"
  variant_smoke="passed"
  if [[ "$keep_lease" != "1" ]]; then
    stop_lease "$variant_lease"
    variant_lease=""
  fi

  default_lease="$(warmup default)"
  default_image="$(selected_image_id "$log_dir/default.log")"
  if [[ -z "$default_image" ]]; then
    printf 'default warmup did not report its selected image; log=%s\n' "$log_dir/default.log" >&2
    exit 1
  fi
  if [[ "$default_image" == "$ami_id" ]]; then
    printf 'generic desktop selection changed to catalog-only AMI %s.\n' "$ami_id" >&2
    exit 1
  fi
  default_unchanged="passed:${default_image}"
  if [[ "$keep_lease" != "1" ]]; then
    stop_lease "$default_lease"
    default_lease=""
  fi
fi

jq -n \
  --arg amiId "$ami_id" \
  --arg name "$image_name" \
  --arg region "$region" \
  --arg version "$telegram_version" \
  --arg promotion "$promotion_status" \
  --arg variantSelection "$variant_selection" \
  --arg variantSmoke "$variant_smoke" \
  --arg defaultUnchanged "$default_unchanged" \
  '{
    amiId: $amiId,
    name: $name,
    region: $region,
    telegramDesktopVersion: $version,
    proofs: {
      sourceSmoke: "passed",
      candidateSelection: "explicit",
      candidateSmoke: "passed",
      promotion: $promotion,
      variantSelection: $variantSelection,
      variantSmoke: $variantSmoke,
      defaultUnchanged: $defaultUnchanged
    }
  }' >"$output_file"

cat <<EOF
Telegram Desktop image bake complete
  AMI:                 $ami_id
  name:                $image_name
  region:              $region
  source smoke:        passed
  candidate selection: explicit
  candidate smoke:     passed
  promotion:           $promotion_status
  variant selection:   $variant_selection
  variant smoke:       $variant_smoke
  default unchanged:   $default_unchanged
  summary:             $output_file
EOF
