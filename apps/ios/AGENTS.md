# iOS Release Agent Policy

Root rules still apply. This file adds the iOS release guardrails.

## UI / Typography

- iOS SwiftUI text should use branded typography helpers, not bare system fonts. Use `OpenClawType` in `apps/ios/Sources/**`, `OpenClawChatTypography` in shared chat UI, `WatchClawType` in watch UI, and `OpenClawActivityType` in Live Activity UI.
- Apply branded fonts at the rendered text/control boundary when practical: `Text`, `Label`, `Button` labels, picker options, menu items, alert text/buttons, row titles/subtitles, placeholder overlays, chips, badges, and toolbar actions. Do not rely on distant parent `.font(...)` inheritance for user-visible text when a local modifier is cheap and clear.
- Avoid shorthand controls like `Button("Title")`, `Link("Title", ...)`, `TextField("Placeholder", ...)`, and `SecureField("Placeholder", ...)` when they make typography or placeholder styling implicit. Prefer explicit label builders with branded `Text`/`Label`.
- Secure-field placeholders need both branded visual styling and accessibility semantics. If using an overlay placeholder, keep the actual field semantically named with `.accessibilityLabel(...)` and hide the decorative placeholder from accessibility.
- System font modifiers are acceptable for SF Symbol `Image(systemName:)` sizing, not for user-visible text unless a platform control makes branded typography impossible. If an exception is intentional, keep it narrow and explain why.
- When touching iOS text surfaces, update/keep `apps/ios/Tests/OpenClawTypographyTests.swift` so bare text/control regressions are caught, then run the focused typography test.

## Licenses Screen

- Maintain the Settings-tab Licenses screen when iOS app dependencies change.
- Bundled license files live in `apps/ios/Resources/Licenses/`.
- License files must be UTF-8 `.txt` files. Do not add Markdown, HTML, RTF, or generated plist license content.
- The Licenses screen discovers bundled `.txt` files at runtime through `LicenseDocumentLoader`; do not hardcode individual license rows in Swift.
- License rows are ordered alphabetically in code by derived display title. Do not use numeric filename prefixes for ordering.
- Filenames should be plain dependency names, for example `WebRTC.txt`; the filename is used only to derive the row title and must not be shown as a row subtitle.
- Do not add OpenClaw, OpenClaw Foundation, or other first-party/self-owned license entries. The screen is for third-party/open-source dependency acknowledgements.
- When adding, removing, or upgrading iOS dependencies, audit whether `apps/ios/Resources/Licenses/` needs updates. Exclude dependencies owned by OpenClaw Foundation from the published license list.
- When adding, removing, or replacing redistributed font binaries under `apps/ios/Sources/Fonts/`, update `apps/ios/THIRD_PARTY_FONTS.md` with immutable upstream source URLs and SHA-256 checksums for each bundled file.
- Keep license detail bodies rendered as verbatim monospace text.
- Keep the Settings Licenses row at the bottom Settings section with no section title unless product direction changes.
- When changing license loading or presentation, update `apps/ios/Tests/LicenseDocumentLoaderTests.swift` and `apps/ios/Tests/SwiftUIRenderSmokeTests.swift`, then run focused iOS tests.

## App Store Releases

- Agent-driven App Store uploads must use only `pnpm ios:release:upload`.
- Release selection belongs to the pipeline. Run `pnpm ios:release:plan -- --json`; if it reports `changelogStatus: needs-cut`, run `pnpm ios:release:cut`, review and commit `apps/ios/CHANGELOG.md`, then run `pnpm ios:release:upload` without release arguments.
- The planner derives the gateway version from the canonical root version, reuses the one editable App Store revision for that gateway, retries an unreleased revision found in App Store Connect build-upload history, and allocates the next revision only after released history. Historical exact gateway versions consume revision zero.
- Build allocation uses App Store Connect `buildUploads`, including awaiting, processing, failed, and complete uploads. Every Apple-visible attempt consumes its build number; retries increment the build within the same App Store revision.
- Only one iOS release uploader may run at a time. Multiple active App Store versions, locked/in-review state, a different active gateway, unknown upload state, or revision exhaustion must fail closed for human resolution.
- `--version`, `--revision`, and `--build-number` remain checked overrides. The pipeline must reject an override that differs from the live deterministic plan. `--version` is always the gateway version, never the encoded App Store version.
- Do not infer release identity from the current date, mobile-release refs, or generated local files. `## Unreleased` supplies notes only through the deterministic cutter; it does not select a revision.
- If `pnpm ios:release:upload` exits non-zero, stop immediately and report the failing step.
- After a failed `pnpm ios:release:upload`, do not continue with a lower-level upload path. A human may repair App Store Connect state; the next pipeline run re-plans the same revision and next build automatically.
- Do not submit an iOS App Store version for App Review. App Review submission stays manual unless the user explicitly asks to submit a specific already-prepared version after the failed state has been reported.
- `pnpm ios:release:archive` is for local archive validation only. It is not a fallback release path after screenshot, metadata, or upload-lane failure.
