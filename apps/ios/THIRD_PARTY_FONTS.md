# Third-Party Font Provenance

These font binaries are redistributed in the iOS app, Watch app, and Live Activity targets. Keep this file in sync with `apps/ios/Sources/Fonts/` whenever bundled font files are added, removed, or replaced.

The Settings Licenses screen uses `apps/ios/Resources/Licenses/*.txt` for user-visible acknowledgements. This manifest is for maintainer audit of the exact redistributed binary assets.

Last verified: 2026-07-03.

| Bundled file | Upstream project | License | Immutable upstream source | SHA-256 |
| --- | --- | --- | --- | --- |
| `apps/ios/Sources/Fonts/Inter[opsz,wght].ttf` | Inter | SIL Open Font License 1.1 | `https://raw.githubusercontent.com/google/fonts/e4572de925a4c3be12f1f9983ee0adbe1eb6e9fe/ofl/inter/Inter%5Bopsz,wght%5D.ttf` | `29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031` |
| `apps/ios/Sources/Fonts/Inter-Italic[opsz,wght].ttf` | Inter | SIL Open Font License 1.1 | `https://raw.githubusercontent.com/google/fonts/e4572de925a4c3be12f1f9983ee0adbe1eb6e9fe/ofl/inter/Inter-Italic%5Bopsz,wght%5D.ttf` | `acd98e64795781b2058f07b18475e0ecee2a0fe2b42a49e2f9e37d0d6bf66ce6` |
| `apps/ios/Sources/Fonts/JetBrainsMono-Regular.ttf` | JetBrains Mono | SIL Open Font License 1.1 | `https://raw.githubusercontent.com/JetBrains/JetBrainsMono/cd5227bd1f61dff3bbd6c814ceaf7ffd95e947d9/fonts/ttf/JetBrainsMono-Regular.ttf` | `a0bf60ef0f83c5ed4d7a75d45838548b1f6873372dfac88f71804491898d138f` |
| `apps/ios/Sources/Fonts/JetBrainsMono-Medium.ttf` | JetBrains Mono | SIL Open Font License 1.1 | `https://raw.githubusercontent.com/JetBrains/JetBrainsMono/cd5227bd1f61dff3bbd6c814ceaf7ffd95e947d9/fonts/ttf/JetBrainsMono-Medium.ttf` | `31c92d01a8a08528b718a43addf0ad3df0af2ca4b7b3290a452f70f358e14d3d` |
| `apps/ios/Sources/Fonts/JetBrainsMono-SemiBold.ttf` | JetBrains Mono | SIL Open Font License 1.1 | `https://raw.githubusercontent.com/JetBrains/JetBrainsMono/cd5227bd1f61dff3bbd6c814ceaf7ffd95e947d9/fonts/ttf/JetBrainsMono-SemiBold.ttf` | `1b3bfa1ed5665a4ce3f9feb68d2d4e40e70bf8b4b7d9a3edd418f321b4e166a0` |
| `apps/ios/Sources/Fonts/RedHatDisplay[wght].ttf` | Red Hat Display | SIL Open Font License 1.1 | `https://raw.githubusercontent.com/google/fonts/e4572de925a4c3be12f1f9983ee0adbe1eb6e9fe/ofl/redhatdisplay/RedHatDisplay%5Bwght%5D.ttf` | `46c9d4c4a2415e7e72020b318f5cda2bcbc9018d78b1a67e480a76d8d6e4b379` |

To verify local hashes:

```sh
find apps/ios/Sources/Fonts -maxdepth 1 -type f -print | sort | xargs shasum -a 256
```
