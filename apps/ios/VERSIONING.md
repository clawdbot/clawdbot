# OpenClaw iOS Versioning

OpenClaw iOS releases retain their gateway association while allowing multiple
public App Store releases for one gateway version. The release planner derives
the active release identity from the repository and App Store Connect.

## Goals

- keep the associated gateway version recognizable
- support multiple public iOS releases per gateway version
- support multiple candidate builds per App Store version
- make every release identity deterministic and inspectable before upload
- keep Apple bundle fields valid for App Store Connect
- generate version-specific App Store release notes from the iOS changelog

## Version model

An iOS release has three independent identifiers:

- gateway version `G = YYYY.M.P`, for example `2026.7.2`
- App Store revision `R`, a single digit from `0` through `9`
- build number `B`, a positive integer scoped to the exact App Store version

The App Store version appends the revision directly to the gateway patch with no padding:

```text
AppStoreVersion(G, R) = YYYY.M.concat(P, R)
```

Examples:

| Gateway | Revision | App Store version | Candidate builds |
| --- | ---: | --- | --- |
| `2026.7.2` | legacy `0` | `2026.7.2` | closed history |
| `2026.7.2` | `1` | `2026.7.21` | `1`, `2`, `3` |
| `2026.7.2` | `2` | `2026.7.22` | `1`, `2`, ... |
| `2026.7.3` | `0` | `2026.7.30` | `1`, `2`, ... |

Historical exact versions through `2026.7.2` are grandfathered as read-only
release history and consume revision zero for their gateway. That explicit
cutover keeps later appended versions such as `2026.7.21` from being mistaken
for a future gateway's exact legacy release. The release tooling does not target
exact versions again; all future uploads use the appended single-digit format.

## Release commands

Inspect the read-only release plan:

```bash
pnpm ios:release:plan -- --json
```

Cut `## Unreleased` notes into the planned encoded version, commit the result,
then upload:

```bash
pnpm ios:release:cut
pnpm ios:release:upload
```

`--version`, `--revision`, and `--build-number` remain available as checked
overrides. Upload rejects any override that differs from the live plan. Offline
archive validation still requires explicit values:

```bash
pnpm ios:release:archive -- --version 2026.7.2 --revision 1 --build-number 3
```

## Apple bundle mapping

Gateway `2026.7.2`, revision `1`, build `3` maps to:

- `OpenClawCanonicalVersion = 2026.7.2`
- `CFBundleShortVersionString = 2026.7.21`
- `CFBundleVersion = 3`

Local development builds continue using the normalized gateway version as the
marketing version. Release preparation supplies the explicit revision and
therefore the appended App Store version.

## Revision and build lifecycle

- A revision is reserved once its App Store version record is created and is
  never reused.
- Awaiting, processing, failed, and complete uploads stay on the same App Store
  version and increment only the build number.
- After an App Store version is distributed, another public release for the
  same gateway uses the next revision and resets its build number to `1`.
- Build numbers come from the highest App Store Connect `buildUploads` record
  for the exact version plus one. Failed local archives do not consume build
  numbers; every Apple-visible upload reservation or attempt does.
- App Review submission remains manual.

Before screenshot or archive work, the upload lane checks App Store Connect:

- an absent version may be created during metadata staging
- the one editable version for the current gateway is reused
- a locked or in-review version fails the run
- an unreleased revision present only in build-upload history is retried
- a distributed version requires the next revision
- multiple active versions, a different active gateway, and unknown upload
  states fail closed for human resolution

Only one iOS release uploader may run at a time. The pipeline rechecks the
exact plan after local archive and Transporter validation, immediately before
its first App Store mutation. After upload it waits up to one hour for Apple
processing, then fails the attempt rather than polling indefinitely.

## Release notes

Production release notes require an exact App Store version heading:

```markdown
## 2026.7.21

- Fixed an iOS issue.
```

The generated App Store text automatically starts with:

```text
Gateway version: 2026.7.2
```

Production revision builds do not fall back to the gateway heading or
`## Unreleased`. Local version checks without `--revision` retain the existing
gateway/`Unreleased` fallback for development.

The cutter moves new notes into that exact heading and is idempotent:

```bash
pnpm ios:release:cut
```

## Source of truth and generated files

Source files:

- root `package.json`: default gateway version for local builds and release planning
- App Store Connect versions and build uploads: revision/build lifecycle state
- explicit release arguments: checked overrides only
- `apps/ios/CHANGELOG.md`: exact App Store release notes
- `apps/ios/VERSIONING.md`: versioning contract

Generated or derived files:

- `apps/ios/build/Version.xcconfig`
- `apps/ios/build/AppStoreRelease.xcconfig`
- `apps/ios/SwiftSources.input.xcfilelist`
- temporary Fastlane metadata rendered from `apps/ios/CHANGELOG.md`

The canonical implementation is split across:

- `scripts/lib/ios-version.ts`: validation, encoding, and release-note rendering
- `scripts/lib/ios-release-plan.ts`: deterministic revision/build selection and
  changelog cutting
- `scripts/ios-version.ts`: JSON, shell, and single-field queries
- `scripts/ios-release-plan.ts`: pure planner CLI used by the Fastlane adapter
- `scripts/ios-release-{plan,cut}.sh`: public planning and cutting entry points
- `scripts/ios-sync-versioning.ts`: release-note validation
- `scripts/ios-release-upload.sh`: guarded upload entry point
- `apps/ios/fastlane/Fastfile`: remote preflight, build allocation, metadata,
  archive, validation, and upload

## Release SHA tracking

Successful uploads record the exact App Store version and build:

```text
refs/openclaw/mobile-releases/ios/<CFBundleShortVersionString>-<CFBundleVersion>
```

For example:

```text
refs/openclaw/mobile-releases/ios/2026.7.21-3
```

The ref is checked before archive/upload work and created only after App Store
Connect accepts the upload. Existing refs are immutable.

## Normal workflow

1. Inspect the plan:

```bash
pnpm ios:release:plan -- --json
```

2. Cut and commit release notes when the plan reports `needs-cut`.
3. Upload the planned build:

```bash
pnpm ios:release:upload
```

4. If the run fails, stop. After a human repairs App Store Connect, rerun the
   same pipeline; it keeps the revision and advances the build automatically.
5. Select one processed build and submit it manually in App Store Connect.
6. After distribution, the next run allocates the next App Store revision.

Agent-driven uploads must use `pnpm ios:release:upload`. A failed upload is
terminal for that attempt: report the failing step rather than switching to a
lower-level archive, upload, staging, or submission command.
