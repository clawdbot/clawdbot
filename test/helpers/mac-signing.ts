import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MacScriptFixture } from "../scripts/mac-script-fixture.test-support.js";
import { machoFixture } from "./mac-native.js";

const nativeMetadataReply = `
for arg in "$@"; do
  if [ "$arg" = "-dv" ]; then
    printf '%s\\n' 'Format=Mach-O thin (arm64)' 'CodeDirectory v=20400 size=0 flags=0x0(none)' 'TeamIdentifier=not set' >&2
    exit 0
  fi
done
`;

export function installFakeCodesign(binDir: string) {
  const fakeCodesign = path.join(binDir, "codesign");
  writeFileSync(
    fakeCodesign,
    `#!/usr/bin/env bash
set -euo pipefail
${nativeMetadataReply}
if [ -n "\${CODESIGN_ARGS_LOG:-}" ]; then
  printf '%s\\n' "$*" >>"$CODESIGN_ARGS_LOG"
fi

entitlements=""
target=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --entitlements)
      shift
      entitlements="$1"
      ;;
  esac
  target="$1"
  shift || true
done

if [ -z "$target" ]; then
  echo "missing codesign target" >&2
  exit 2
fi

if [ -n "$entitlements" ]; then
  count_file="$CODESIGN_CAPTURE_DIR/count"
  count=0
  if [ -f "$count_file" ]; then
    count="$(cat "$count_file")"
  fi
  count=$((count + 1))
  printf '%s' "$count" >"$count_file"
  copy="$CODESIGN_CAPTURE_DIR/entitlements-$count.plist"
  cp "$entitlements" "$copy"
  printf 'entitled\\t%s\\t%s\\t%s\\n' "$target" "$entitlements" "$copy" >>"$CODESIGN_LOG"
else
  printf 'plain\\t%s\\n' "$target" >>"$CODESIGN_LOG"
fi
`,
  );
  chmodSync(fakeCodesign, 0o755);
}

export function installTransientFakeCodesign(binDir: string) {
  const fakeCodesign = path.join(binDir, "codesign");
  writeFileSync(
    fakeCodesign,
    `#!/usr/bin/env bash
set -euo pipefail
${nativeMetadataReply}
count=0
if [ -f "$CODESIGN_COUNT_FILE" ]; then
  count="$(cat "$CODESIGN_COUNT_FILE")"
fi
count=$((count + 1))
printf '%s' "$count" >"$CODESIGN_COUNT_FILE"
printf '%s' "$TMPDIR" >"$CODESIGN_COUNT_FILE.tempdir"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--entitlements" ]; then
    test -f "$2"
    printf '%s' "$2" >"$CODESIGN_COUNT_FILE.entitlements"
  fi
  shift
done
if [ "\${CODESIGN_PERMANENT_FAILURE:-0}" = "1" ]; then
  echo "signing identity is not available" >&2
  exit 7
fi
if [ "$count" -le "$CODESIGN_TRANSIENT_FAILURES" ]; then
  echo "A timestamp was expected but was not found" >&2
  exit 1
fi
`,
  );
  chmodSync(fakeCodesign, 0o755);
}

export function installElevationFakeCodesign(binDir: string) {
  const fakeCodesign = path.join(binDir, "codesign");
  writeFileSync(
    fakeCodesign,
    `#!/usr/bin/env bash
set -euo pipefail

for arg in "$@"; do
  if [ "$arg" = "-dv" ]; then
    printf '%s\n' 'Format=Mach-O thin (arm64)' >&2
    printf '%s\n' 'CodeDirectory v=20400 size=231 flags=0x10000(runtime) hashes=2+2 location=embedded' >&2
    printf '%s\n' 'TeamIdentifier=FWJYW4S8P8' >&2
    if [ "\${CODESIGN_FAKE_NO_AUTHORITY:-0}" != "1" ]; then
      printf '%s\n' 'Authority=Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)' >&2
    fi
    if [ "\${CODESIGN_FAKE_SECOND_AUTHORITY:-0}" = "1" ]; then
      printf '%s\n' 'Authority=Unexpected Secondary Authority' >&2
    fi
    for i in $(seq 1 20000); do
      printf 'Metadata-%s=value\n' "$i" >&2
    done
    if [ "\${CODESIGN_FAKE_FAIL_AFTER_METADATA:-0}" = "1" ]; then
      exit 7
    fi
    exit 0
  fi
done
exit 0
`,
  );
  chmodSync(fakeCodesign, 0o755);
}

type SigningEvent = {
  args: string[];
  entitlements: string;
  resolvedTarget?: string;
  mutationAttempt?: boolean;
};
type FileEvent = { args: string[]; magics: string[] };

export function makeSigningFixture(mac: MacScriptFixture, root: string, appName = "Odd ' app.app") {
  const app = path.join(root, appName);
  const worker = path.join(app, "Contents/Resources/node-worker/arm64");
  const bin = path.join(root, "bin");
  const options = path.join(root, "options.json");
  const capture = path.join(app, "Contents/test-capture");
  const events = path.join(capture, "signing.jsonl");
  // Read-only discovery must not mutate the input tree it is auditing.
  const files = path.join(root, "file.jsonl");
  const sealed = path.join(capture, "sealed");
  const swaps = path.join(capture, "swaps.jsonl");
  for (const dir of [worker, bin, capture]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(options, "{}");
  const fake = path.join(bin, "codesign");
  writeFileSync(
    fake,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2), target = args.at(-1);
const config = JSON.parse(fs.readFileSync(${JSON.stringify(options)}, 'utf8'));
(async () => {
if (config.swapStage === 'before-sign' && args.includes('--sign') && target === config.swapTarget) {
  // An external driver swaps the directory only after the confined signer is ready.
  await new Promise((resolve, reject) => {
    const socket = require('node:net').createConnection(config.swapSocket);
    socket.on('error', reject);
    socket.on('connect', () => socket.write('ready'));
    socket.on('data', () => { socket.end(); resolve(); });
  });
}
const ent = args.includes('--entitlements') && !args.includes('-d') ? fs.readFileSync(args[args.indexOf('--entitlements') + 1], 'utf8') : '';
const resolvedTarget = config.swapStage ? fs.realpathSync(target) : undefined;
const mutationAttempt = args.includes('--sign') && target === (config.writeTarget || config.swapTarget);
fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify({args, entitlements: ent, resolvedTarget, mutationAttempt}) + '\\n');
if (mutationAttempt) {
  try { fs.appendFileSync(target, '\\nfixture-signature\\n'); }
  catch (error) { console.error('signing write rejected: ' + error.code); process.exit(73); }
}
if (args.includes('-dv')) {
  console.error('Executable=' + target);
  console.error('Identifier=' + require('node:path').basename(target));
  if (config.signatureFormat !== 'missing') console.error('Format=' + (target === config.format ? 'generic' : 'Mach-O thin (arm64)'));
  console.error('CodeDirectory v=20400 size=231 flags=0x10000(runtime) hashes=2+2 location=embedded');
  if (config.metadata !== 'missing') console.error('TeamIdentifier=' + (target === config.mismatch ? 'WRONG' : 'FWJYW4S8P8'));
  console.error('Authority=' + (config.authority || 'Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)'));
  if (config.metadata === 'failure' || config.metadataFailure === target) process.exit(7);
}
if (args.includes('-d')) {
  if (config.appleEvents === target) console.log('<key>com.apple.security.automation.apple-events</key>');
  if (config.entitlementFailure === target) process.exit(8);
}
if (args.includes('--verify') && config.verifyFailure === target) process.exit(9);
if (args.includes('--sign') && target === ${JSON.stringify(app)}) {
  fs.writeFileSync(${JSON.stringify(sealed)}, 'sealed');
  if (config.generated) fs.writeFileSync(config.generated, Buffer.from(config.generatedHex, 'hex'));
}
})().catch(error => { console.error(error); process.exit(74); });
`,
  );
  chmodSync(fake, 0o755);
  const boundary = path.join(root, "boundary.py");
  writeFileSync(
    boundary,
    `import json, os, runpy, subprocess, sys
config = json.load(open(${JSON.stringify(options)}))
real_run = subprocess.run
mode = sys.argv.pop(1)
active = config.get('phase', 'before') == ('after' if os.path.exists(${JSON.stringify(sealed)}) else 'before')
fault = config.get('fault') if active else None
swap_stage = config.get('swapStage') if active else None
swapped = os.path.exists(${JSON.stringify(swaps)})
real_open, real_scandir = os.open, os.scandir
original_directory = os.stat(config['swapDirectory'], follow_symlinks=False) if swap_stage else None

def swap_directory(stage):
    global swapped
    if swapped or swap_stage != stage: return
    os.rename(config['swapDirectory'], config['retainedDirectory'])
    os.symlink(config['externalDirectory'], config['swapDirectory'])
    with open(${JSON.stringify(swaps)}, 'a') as log:
        log.write(json.dumps({'stage': stage}) + '\\n')
    swapped = True

def matches_directory(filename, dir_fd=None):
    if swapped or not swap_stage: return False
    current = os.fstat(filename) if isinstance(filename, int) else os.stat(filename, dir_fd=dir_fd, follow_symlinks=False)
    return os.path.samestat(original_directory, current)

def open_directory(filename, flags, *args, **kwargs):
    matches = matches_directory(filename, kwargs.get('dir_fd'))
    if matches: swap_directory('before-directory-open')
    fd = real_open(filename, flags, *args, **kwargs)
    if matches: swap_directory('after-directory-open')
    return fd

def scan_directory(filename):
    matches = matches_directory(filename)
    if matches: swap_directory('before-directory-open')
    entries = real_scandir(filename)
    if matches: swap_directory('after-directory-open')
    return entries

if swap_stage:
    os.open, os.scandir = open_directory, scan_directory

def classify(args, **kwargs):
    descriptors = kwargs.get('pass_fds', ())
    magics = [os.pread(fd, 4, 0).hex() for fd in descriptors]
    with open(${JSON.stringify(files)}, 'a') as log:
        log.write(json.dumps({'args': args, 'magics': magics}) + '\\n')
    with open(${JSON.stringify(files)}) as log:
        if sum(1 for _ in log) > config.get('maxFileCalls', 100):
            raise RuntimeError('classification process budget exceeded')
    if fault == 'spawn': raise OSError('classifier spawn failure')
    swap_directory('before-classification')
    result = real_run(args, **kwargs)
    swap_directory('after-classification')
    if fault == 'classifier': result.returncode = 7
    if fault == 'empty': result.stdout = b''
    if fault == 'partial': result.stdout = result.stdout.split(b'\\0')[0] + b'\\0'
    if fault == 'unterminated': result.stdout = result.stdout.rstrip(b'\\0')
    if fault == 'error-record': result.stdout = b'ERROR: cannot read\\0'
    return result

if mode == 'file':
    result = classify(['/usr/bin/file', *sys.argv[1:]], stdout=subprocess.PIPE)
    sys.stdout.buffer.write(result.stdout)
    sys.exit(result.returncode)
if mode == 'mutate':
    sys.argv = sys.argv[1:]
    runpy.run_path(sys.argv[0], run_name='__main__')
    sys.exit(0)
if fault == 'scanner':
    sys.stdout.buffer.write(b'executable\\0' + os.fsencode(config['partialPath']) + b'\\0')
    sys.exit(9)
if fault == 'walk':
    def fail_walk(*args, **kwargs): raise OSError('inventory traversal failure')
    os.scandir = fail_walk
subprocess.run = classify
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name='__main__')
`,
  );
  const bashEnv = path.join(root, "bash-env");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(
    bashEnv,
    `function /usr/bin/file() { command /usr/bin/python3 ${quote(boundary)} file "$@"; }
function /usr/bin/python3() {
  case "$1" in
    */mac-bundle-mutation.py) command /usr/bin/python3 ${quote(boundary)} mutate "$@" ;;
    *) command /usr/bin/python3 ${quote(boundary)} scan "$@" ;;
  esac
}
`,
  );
  const driver = path.join(root, "swap-driver.py");
  writeFileSync(
    driver,
    `import json, os, select, socket, subprocess, sys, tempfile
config = json.load(open(${JSON.stringify(options)}))
# A short, private path stays below Darwin's Unix socket pathname limit.
with tempfile.TemporaryDirectory(prefix='oc-sign-swap-', dir='/tmp') as control:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
        config['swapSocket'] = os.path.join(control, 'socket')
        server.bind(config['swapSocket'])
        server.listen(1)
        with open(${JSON.stringify(options)}, 'w') as output: json.dump(config, output)
        child = subprocess.Popen(['/bin/bash', *sys.argv[1:]], close_fds=True)
        while child.poll() is None:
            if not select.select([server], [], [], 0.05)[0]: continue
            connection, _ = server.accept()
            with connection:
                if connection.recv(5, socket.MSG_WAITALL) != b'ready': raise ValueError('Missing signer readiness')
                os.rename(config['swapDirectory'], config['retainedDirectory'])
                os.symlink(config['externalDirectory'], config['swapDirectory'])
                with open(${JSON.stringify(swaps)}, 'a') as log:
                    log.write(json.dumps({'stage': config['swapStage']}) + '\\n')
                connection.sendall(b'done')
            break
        sys.exit(child.wait())
`,
  );
  function readEvents<T>(filename: string): T[] {
    return existsSync(filename)
      ? readFileSync(filename, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  }
  return {
    app,
    worker,
    put(relative: string, data: Buffer | string = machoFixture()) {
      const filename = path.join(app, relative);
      mkdirSync(path.dirname(filename), { recursive: true });
      writeFileSync(filename, data);
      return filename;
    },
    run(config: Record<string, unknown> = {}, elevation = false, target = app) {
      writeFileSync(options, JSON.stringify(config));
      const command = config.swapStage === "before-sign" ? "/usr/bin/python3" : "/bin/bash";
      const args = ["scripts/codesign-mac-app.sh", target];
      return mac.run(command, config.swapStage === "before-sign" ? [driver, ...args] : args, {
        encoding: "utf8",
        env: {
          HOME: root,
          TMPDIR: root,
          PATH: `${bin}:/usr/bin:/bin`,
          BASH_ENV: bashEnv,
          SIGN_IDENTITY: "Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)",
          ...(config.skipTeam === true ? { SKIP_TEAM_ID_CHECK: "1" } : {}),
          ...(elevation ? { OPENCLAW_MAC_SIGNING_VARIANT: "elevation-host" } : {}),
        },
      });
    },
    scan(config: Record<string, unknown> = {}) {
      writeFileSync(options, JSON.stringify(config));
      return mac.run(
        "/usr/bin/python3",
        [boundary, "scan", "scripts/lib/mac-native-inventory.py", app],
        {
          encoding: "utf8",
        },
      );
    },
    events: () => readEvents<SigningEvent>(events),
    swaps: () => readEvents<{ stage: string }>(swaps),
    classifications: () => readEvents<FileEvent>(files),
  };
}
