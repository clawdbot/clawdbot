---
summary: "Remove FaceTime native artifacts and restore standard Mac security policy"
read_when:
  - You are uninstalling the experimental FaceTime plugin
  - Helper injection or the paired audio driver needs recovery
title: "FaceTime recovery and removal"
---

This procedure removes the FaceTime plugin's native artifacts and describes
the separate operator actions needed to restore the Mac's standard security
posture. OpenClaw never changes SIP automatically.

## Remove driver and helper artifacts

End any active call, then run:

```bash
openclaw gateway call facetime.uninstall --json
openclaw plugins disable facetime
```

The uninstall removes the HAL driver, cached driver output, staged and
timestamped helper dylibs for FaceTime and Phone, the helper key, and the staged
helper build stamp. It does not kill unrelated processes.

Quit and reopen FaceTime and Phone so neither app retains a mapped helper.
If an app will not quit normally, terminate only that exact app from Activity
Monitor and reopen it. Do not use broad process-name kill commands.

Verify that `OpenClaw-Mic` and `OpenClaw-Feed` no longer appear:

```bash
system_profiler SPAudioDataType
```

## Restore SIP debugging restrictions

If you previously accepted the private-helper tradeoff and disabled debugging
restrictions, restore standard SIP from macOS Recovery:

1. Shut down the Mac.
2. Hold the power button until startup options appear.
3. Choose **Options**, authenticate, and open Terminal from Utilities.
4. Run `csrutil enable`.
5. Reboot and verify with `csrutil status`.

Do not modify SIP merely to diagnose a driver or configuration problem.

## Recover a failed driver update

Driver replacement is transactional. A failed staged or post-swap verification
restores the previous driver and does not restart Core Audio. If status remains
`invalid` or `outdated`, rerun `facetime.updateDriver` from an interactive admin
session and inspect its exact error. Never copy an unverified driver into
`/Library/Audio/Plug-Ins/HAL` manually.

The installer intentionally rejects Xcode that is not canonical, Apple-signed,
root-owned, or free of group/world-writable content. Reinstall Xcode from Apple
into `/Applications` using an administrator-managed installation. If the error
names a writable path component, an administrator must remove group/world write
access from that component, including `/Applications`, according to the Mac's
software-management policy. Do not work around the check by changing the
plugin, supplying another compiler path, or copying a locally built driver into
the HAL directory.
