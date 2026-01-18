import Foundation
import Testing
@testable import Clawdbot

struct ExecAllowlistTests {
    @Test func matchUsesResolvedPath() {
        let entry = ExecAllowlistEntry(pattern: "/opt/homebrew/bin/rg")
        let resolution = ExecCommandResolution(
            rawExecutable: "rg",
            resolvedPath: "/opt/homebrew/bin/rg",
            executableName: "rg",
            cwd: nil)
        let match = ExecAllowlistMatcher.match(entries: [entry], resolution: resolution)
        #expect(match?.pattern == entry.pattern)
    }

    @Test func matchUsesBasenameForSimplePattern() {
        let entry = ExecAllowlistEntry(pattern: "rg")
        let resolution = ExecCommandResolution(
            rawExecutable: "rg",
            resolvedPath: "/opt/homebrew/bin/rg",
            executableName: "rg",
            cwd: nil)
        let match = ExecAllowlistMatcher.match(entries: [entry], resolution: resolution)
        #expect(match?.pattern == entry.pattern)
    }

    @Test func matchIsCaseInsensitive() {
        let entry = ExecAllowlistEntry(pattern: "RG")
        let resolution = ExecCommandResolution(
            rawExecutable: "rg",
            resolvedPath: "/opt/homebrew/bin/rg",
            executableName: "rg",
            cwd: nil)
        let match = ExecAllowlistMatcher.match(entries: [entry], resolution: resolution)
        #expect(match?.pattern == entry.pattern)
    }

    @Test func matchSupportsGlobStar() {
        let entry = ExecAllowlistEntry(pattern: "/opt/**/rg")
        let resolution = ExecCommandResolution(
            rawExecutable: "rg",
            resolvedPath: "/opt/homebrew/bin/rg",
            executableName: "rg",
            cwd: nil)
        let match = ExecAllowlistMatcher.match(entries: [entry], resolution: resolution)
        #expect(match?.pattern == entry.pattern)
    }
}
