# Crabbox visual proof

The automated Test Server pool contains TDLib sessions, not Telegram Desktop
`tdata`. Visual proof remains a separate held `telegram-user` lease.

For PR review or repro, a held session keeps the Convex user lease and desktop
recording alive while you iterate.

## 1. Start

```bash
pnpm qa:telegram-user:crabbox -- start \
  --tdlib-url https://registry.npmjs.org/@prebuilt-tdlib/linux-x64-glibc/-/linux-x64-glibc-0.1008067.0.tgz \
  --tdlib-sha256 564c69f81a7537f2857e94a53cdde363d9e51a2fca48d26b365b8d9bb9ad637d \
  --output-dir .artifacts/qa-e2e/telegram-user-crabbox/pr-review
```

Done when `start` returns a session file, Telegram Desktop is signed in, the
current checkout runs as the SUT, and recording is active.

## 2. Drive and capture

```bash
pnpm qa:telegram-user:crabbox -- send --session <session.json> --text /status
pnpm qa:telegram-user:crabbox -- screenshot --session <session.json>
```

Done when the desktop visibly contains the sent action and resulting SUT state.

## 3. Finish

```bash
pnpm qa:telegram-user:crabbox -- finish --session <session.json>
```

Done when the credential is released, the box stops unless `--keep-box` was
requested, and the screenshot plus recording remain in the output directory.
