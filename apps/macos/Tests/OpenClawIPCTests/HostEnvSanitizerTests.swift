import Testing
@testable import OpenClaw

struct HostEnvSanitizerTests {
    @Test(arguments: ["cat", ""])
    func `no pager overrides never forward an executable`(value: String) {
        let overrides = ["GIT_PAGER": value, "PAGER": value]
        let diagnostics = HostEnvSanitizer.inspectOverrides(overrides: overrides)
        #expect(diagnostics.blockedKeys.isEmpty)
        #expect(diagnostics.invalidKeys.isEmpty)
        for shellWrapper in [false, true] {
            let env = HostEnvSanitizer.sanitize(overrides: overrides, shellWrapper: shellWrapper)
            #expect(env["GIT_PAGER"] == "")
            #expect(env["PAGER"] == "")
        }
    }

    @Test(arguments: ["less", "/bin/cat", "./cat", "CAT", " cat", "cat ", "cat\n", "cat -u", "cat; id", "$(id)"])
    func `executable and near miss pager overrides stay blocked`(value: String) {
        let diagnostics = HostEnvSanitizer.inspectOverrides(overrides: [
            " git_pager ": value, "PaGeR": value,
        ])
        #expect(diagnostics.blockedKeys == ["GIT_PAGER", "PAGER"])
    }

    @Test func `pager exception does not relax other denials`() {
        let diagnostics = HostEnvSanitizer.inspectOverrides(overrides: [
            "MANPAGER": "cat", "PATH": "cat", "LD_PRELOAD": "", "BAD-KEY": "cat",
        ])
        #expect(diagnostics.blockedKeys == ["LD_PRELOAD", "MANPAGER", "PATH"])
        #expect(diagnostics.invalidKeys == ["BAD-KEY"])
    }

    @Test func `sanitize blocks shell trace variables`() {
        let env = HostEnvSanitizer.sanitize(overrides: [
            "SHELLOPTS": "xtrace",
            "PS4": "$(touch /tmp/pwned)",
            "OPENCLAW_TEST": "1",
        ])
        #expect(env["SHELLOPTS"] == nil)
        #expect(env["PS4"] == nil)
        #expect(env["OPENCLAW_TEST"] == "1")
    }

    @Test func `sanitize shell wrapper allows only explicit override keys`() {
        let env = HostEnvSanitizer.sanitize(
            overrides: [
                "LANG": "C",
                "LC_ALL": "C",
                "OPENCLAW_TOKEN": "secret",
                "PS4": "$(touch /tmp/pwned)",
            ],
            shellWrapper: true)

        #expect(env["LANG"] == "C")
        #expect(env["LC_ALL"] == "C")
        #expect(env["OPENCLAW_TOKEN"] == nil)
        #expect(env["PS4"] == nil)
    }

    @Test func `sanitize non shell wrapper keeps regular overrides`() {
        let env = HostEnvSanitizer.sanitize(overrides: ["OPENCLAW_TOKEN": "secret"])
        #expect(env["OPENCLAW_TOKEN"] == "secret")
    }

    @Test func `inspect overrides rejects blocked and invalid keys`() {
        let diagnostics = HostEnvSanitizer.inspectOverrides(overrides: [
            "CLASSPATH": "/tmp/evil-classpath",
            "BAD-KEY": "x",
            "ProgramFiles(x86)": "C:\\Program Files (x86)",
        ])

        #expect(diagnostics.blockedKeys == ["CLASSPATH"])
        #expect(diagnostics.invalidKeys == ["BAD-KEY"])
    }

    @Test func `sanitize accepts Windows-style override key names`() {
        let env = HostEnvSanitizer.sanitize(overrides: [
            "ProgramFiles(x86)": "D:\\SDKs",
            "CommonProgramFiles(x86)": "D:\\Common",
        ])
        #expect(env["ProgramFiles(x86)"] == "D:\\SDKs")
        #expect(env["CommonProgramFiles(x86)"] == "D:\\Common")
    }
}
