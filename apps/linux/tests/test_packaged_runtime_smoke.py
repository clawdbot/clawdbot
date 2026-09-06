import json
from pathlib import Path
import tempfile
import textwrap
import unittest

import packaged_runtime_smoke as smoke


def version_output(*, needs=(), definitions=()):
    lines = [
        "Version symbols section '.gnu.version' contains 1 entry:",
        "  000:   0 (*local*)",
        "Version needs section '.gnu.version_r' contains 1 entry:",
        " Addr: 0x0  Offset: 0x0  Link: 0 (.dynstr)",
        "  000000: Version: 1  File: libc.so.6  Cnt: 1",
    ]
    lines.extend(
        f"  0x0010:   Name: {name}  Flags: none  Version: 2"
        for name in needs
    )
    lines.extend(
        [
            "Version definition section '.gnu.version_d' contains 1 entry:",
            " Addr: 0x0  Offset: 0x0  Link: 0 (.dynstr)",
        ]
    )
    lines.extend(
        f"  0x001c: Rev: 1  Flags: BASE  Index: 1  Cnt: 1  Name: {name}"
        for name in definitions
    )
    return "\n".join(lines) + "\n"


class PackagedRuntimeAbiTest(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.appdir = self.root / "squashfs-root"
        self.appdir.mkdir()
        self.readelf = self.root / "readelf"
        self.readelf.write_text(
            textwrap.dedent(
                """\
                #!/usr/bin/env python3
                from pathlib import Path
                import sys

                target = Path(sys.argv[-1])
                if Path(f"{target}.readelf-error").exists():
                    print(f"readelf: Error: {target}: synthetic failure")
                    raise SystemExit(1)
                print(Path(f"{target}.readelf").read_text(), end="")
                """
            )
        )
        self.readelf.chmod(0o755)

    def tearDown(self):
        self.temporary_directory.cleanup()

    def write_elf(self, path, output):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"\x7fELFsynthetic")
        Path(f"{path}.readelf").write_text(output)
        return path

    def collect(self, appimage_output, appdir_outputs=()):
        appimage = self.write_elf(
            self.root / "OpenClaw.AppImage",
            appimage_output,
        )
        for relative, output in appdir_outputs:
            self.write_elf(self.appdir / relative, output)
        return smoke.collect_abi_report(
            appimage,
            self.appdir,
            readelf=str(self.readelf),
        )

    def test_exact_limits_pass(self):
        report = self.collect(
            version_output(
                needs=(
                    "GLIBC_2.35",
                    "GLIBCXX_3.4.30",
                    "CXXABI_1.3.13",
                    "GCC_12.0.0",
                )
            ),
        )

        smoke.enforce_abi_limits(report)

        self.assertEqual(
            report["maximumRequired"],
            {
                "GLIBC": "2.35",
                "GLIBCXX": "3.4.30",
                "CXXABI": "1.3.13",
                "GCC": "12.0.0",
            },
        )

    def test_versions_above_limits_are_rejected_numerically(self):
        for required in (
            "GLIBC_2.36",
            "GLIBCXX_3.4.31",
            "CXXABI_1.3.14",
            "GCC_13.0.0",
        ):
            with self.subTest(required=required):
                report = self.collect(version_output(needs=(required,)))
                with self.assertRaisesRegex(
                    RuntimeError,
                    rf"{required} .*limit ",
                ):
                    smoke.enforce_abi_limits(report)

    def test_allowed_amd64_cxxabi_variants_pass_and_are_reported(self):
        report = self.collect(
            version_output(
                needs=(
                    "CXXABI_TM_1",
                    "CXXABI_FLOAT128",
                    "CXXABI_1.3.13",
                )
            ),
        )

        smoke.enforce_abi_limits(report)

        self.assertEqual(
            report["files"][0]["requires"]["CXXABI"],
            ["1.3.13", "FLOAT128", "TM_1"],
        )
        self.assertEqual(report["maximumRequired"]["CXXABI"], "1.3.13")

    def test_version_definitions_do_not_affect_requirements(self):
        requirements = smoke.parse_version_needs(
            version_output(
                needs=("GLIBC_2.35",),
                definitions=(
                    "GLIBC_9.99",
                    "GLIBCXX_99.0.0",
                    "CXXABI_99.0.0",
                    "GCC_99.0.0",
                ),
            ),
            "usr/bin/openclaw-desktop",
        )

        self.assertEqual(
            requirements,
            {
                "GLIBC": ["2.35"],
                "GLIBCXX": [],
                "CXXABI": [],
                "GCC": [],
            },
        )

    def test_report_includes_outer_runtime_and_sorts_relative_paths(self):
        appimage = self.write_elf(
            self.root / "OpenClaw.AppImage",
            version_output(needs=("GLIBC_2.34",)),
        )
        self.write_elf(
            self.appdir / "usr/lib/z.so",
            version_output(needs=("GLIBCXX_3.4.29",)),
        )
        self.write_elf(
            self.appdir / "usr/bin/a",
            version_output(needs=("GLIBC_2.17",)),
        )
        (self.appdir / "usr/bin/not-elf").write_text("plain text")
        (self.appdir / "usr/lib/z-link.so").symlink_to("z.so")
        report = smoke.collect_abi_report(
            appimage,
            self.appdir,
            readelf=str(self.readelf),
        )

        self.assertEqual(
            [(entry["path"], entry["source"]) for entry in report["files"]],
            [
                ("OpenClaw.AppImage", "appimage-runtime"),
                ("usr/bin/a", "appdir"),
                ("usr/lib/z.so", "appdir"),
            ],
        )
        self.assertNotIn(str(self.root), json.dumps(report))

    def test_report_output_is_deterministic_and_written_before_rejection(self):
        report = self.collect(
            version_output(needs=("GLIBC_2.36",)),
            (
                (
                    "usr/lib/libexample.so",
                    version_output(needs=("GLIBC_2.17", "GLIBC_2.35")),
                ),
            ),
        )
        first = self.root / "first"
        second = self.root / "second"
        first.mkdir()
        second.mkdir()

        smoke.write_abi_report(first, report)
        smoke.write_abi_report(second, report)
        with self.assertRaisesRegex(RuntimeError, "AppImage ABI floor exceeded"):
            smoke.enforce_abi_limits(report)

        self.assertEqual(
            (first / "abi.json").read_bytes(),
            (second / "abi.json").read_bytes(),
        )

    def test_unknown_abi_variants_fail_closed(self):
        for family, required in (
            ("GLIBC", "GLIBC_ABI_DT_RELR"),
            ("GLIBCXX", "GLIBCXX_DEBUG_MESSAGE_LENGTH"),
            ("CXXABI", "CXXABI_FUTURE"),
            ("CXXABI", "CXXABI_IEEE128_1.3.13"),
            ("GCC", "GCC_PRIVATE"),
        ):
            with self.subTest(required=required):
                with self.assertRaisesRegex(
                    RuntimeError,
                    rf"unknown {family} version {required}",
                ):
                    smoke.parse_version_needs(
                        version_output(needs=(required,)),
                        "usr/lib/libc.so.6",
                    )

    def test_readelf_errors_fail_closed(self):
        appimage = self.write_elf(
            self.root / "OpenClaw.AppImage",
            version_output(),
        )
        Path(f"{appimage}.readelf-error").touch()

        with self.assertRaisesRegex(
            RuntimeError,
            "readelf failed for OpenClaw.AppImage with exit 1",
        ):
            smoke.collect_abi_report(
                appimage,
                self.appdir,
                readelf=str(self.readelf),
            )


if __name__ == "__main__":
    unittest.main()
