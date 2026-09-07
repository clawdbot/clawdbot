# macOS app

- Native owns device-local capability, the offline Connection window, About, and bridge-opened panels.
- Dashboard owns all settings UI. Reject new Gateway-data or app-settings UI in Swift.
- Connection tabs: Connection, Gateways, Debug only while the developer toggle is enabled.
- Device-local settings reach the web only through `openclawDeviceSettings`.
- Canonical bridge contract: `ui/src/app/native-device-settings.ts`; keep wire keys and types aligned.
- Native browser tabs reach the web only through `openclawBrowser`; canonical contract: `ui/src/app/native-browser-bridge.ts`; keep wire keys aligned.
- Bridge mutations use existing native owners; never write `openclaw.json`.
- Preserve `AppLaunchPresentationPolicy` and `--background-only` startup behavior.
- Build app: `swift build --package-path apps/macos --build-system native --product OpenClaw`.
- Compile tests: `swift build --package-path apps/macos --build-system native --build-tests`.
- Swift checks: `scripts/lint-swift.sh macos`; `scripts/format-swift.sh macos`.
- Other checks: `node scripts/check-changed.mjs`; `pnpm native:i18n:verify`.
- Generate localization inventory only with `pnpm native:i18n:baseline`; never edit translation memory.
- Native test isolation: follow `docs/platforms/mac/dev-setup.md#run-native-tests-safely`.
- Full native suite requires disposable macOS CI/VM; never run it on an operator desktop.
- Tests own unique defaults suites, temporary files, and nonpersistent WebKit stores; clean up resources.
- Local pure-logic filters must avoid AppDefaults, Keychain, windows, and operator state.
- Never launch tests or the app against the operator's Gateway or `~/.openclaw`.
