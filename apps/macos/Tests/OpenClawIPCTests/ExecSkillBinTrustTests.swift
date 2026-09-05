import Foundation
import Testing
@testable import OpenClaw

struct ExecSkillBinTrustTests {
    @Test func `build trust index resolves skill bin paths`() throws {
        let fixture = try Self.makeExecutable(named: "jq")
        defer { try? FileManager.default.removeItem(at: fixture.root) }

        let trust = SkillBinsCache._testBuildTrustIndex(
            report: Self.makeReport(bins: ["jq"]),
            searchPaths: [fixture.root.path])

        #expect(trust.names == ["jq"])
        #expect(trust.pathsByName["jq"] == [fixture.path])
    }

    @Test func `skill auto allow accepts trusted resolved skill bin path`() throws {
        let fixture = try Self.makeExecutable(named: "jq")
        defer { try? FileManager.default.removeItem(at: fixture.root) }

        let trust = SkillBinsCache._testBuildTrustIndex(
            report: Self.makeReport(bins: ["jq"]),
            searchPaths: [fixture.root.path])
        let resolution = ExecCommandResolution(
            rawExecutable: "jq",
            resolvedPath: fixture.path,
            executableName: "jq",
            cwd: nil)

        #expect(ExecApprovalEvaluator._testIsSkillAutoAllowed([resolution], trustedBinsByName: trust.pathsByName))
    }

    @Test func `skill auto allow rejects same basename at different path`() throws {
        let trusted = try Self.makeExecutable(named: "jq")
        let untrusted = try Self.makeExecutable(named: "jq")
        defer {
            try? FileManager.default.removeItem(at: trusted.root)
            try? FileManager.default.removeItem(at: untrusted.root)
        }

        let trust = SkillBinsCache._testBuildTrustIndex(
            report: Self.makeReport(bins: ["jq"]),
            searchPaths: [trusted.root.path])
        let resolution = ExecCommandResolution(
            rawExecutable: "jq",
            resolvedPath: untrusted.path,
            executableName: "jq",
            cwd: nil)

        #expect(!ExecApprovalEvaluator._testIsSkillAutoAllowed([resolution], trustedBinsByName: trust.pathsByName))
    }

    @Test func `skill auto allow rejects path scoped invocation`() throws {
        let fixture = try Self.makeExecutable(named: "jq")
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let trust = SkillBinsCache._testBuildTrustIndex(
            report: Self.makeReport(bins: ["jq"]),
            searchPaths: [fixture.root.path])
        let resolution = ExecCommandResolution(
            rawExecutable: fixture.path,
            resolvedPath: fixture.path,
            resolvedRealPath: fixture.path,
            executableName: "jq",
            cwd: nil)

        #expect(!ExecApprovalEvaluator._testIsSkillAutoAllowed([resolution], trustedBinsByName: trust.pathsByName))
    }

    @Test func `skill auto allow rejects retargeted PATH symlink`() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-skill-symlink-\(UUID().uuidString)", isDirectory: true)
            .resolvingSymlinksInPath()
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let first = root.appendingPathComponent("first")
        let second = root.appendingPathComponent("second")
        let alias = root.appendingPathComponent("jq")
        try "#!/bin/sh\nexit 0\n".write(to: first, atomically: true, encoding: .utf8)
        try "#!/bin/sh\nexit 0\n".write(to: second, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: first.path)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: second.path)
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: first)

        let trust = SkillBinsCache._testBuildTrustIndex(
            report: Self.makeReport(bins: ["jq"]),
            searchPaths: [root.path])
        try FileManager.default.removeItem(at: alias)
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: second)
        let resolution = try #require(ExecCommandResolution.resolve(
            command: ["jq"],
            cwd: nil,
            env: ["PATH": root.path]))

        #expect(!ExecApprovalEvaluator._testIsSkillAutoAllowed([resolution], trustedBinsByName: trust.pathsByName))
    }

    @Test func `skill auto allow rejects an alias to a shell carrier`() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-skill-shell-alias-\(UUID().uuidString)", isDirectory: true)
            .resolvingSymlinksInPath()
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let alias = root.appendingPathComponent("skill-shell")
        try FileManager.default.createSymbolicLink(
            at: alias,
            withDestinationURL: URL(fileURLWithPath: "/bin/sh"))

        let trust = SkillBinsCache._testBuildTrustIndex(
            report: Self.makeReport(bins: ["skill-shell"]),
            searchPaths: [root.path])
        let resolution = try #require(ExecCommandResolution.resolve(
            command: ["skill-shell", "-c", "/usr/bin/printf ok"],
            cwd: nil,
            env: ["PATH": root.path]))

        #expect(!ExecApprovalEvaluator._testIsSkillAutoAllowed([resolution], trustedBinsByName: trust.pathsByName))
    }

    private static func makeExecutable(named name: String) throws -> (root: URL, path: String) {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-skill-bin-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent(name)
        try "#!/bin/sh\nexit 0\n".write(to: file, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes(
            [.posixPermissions: NSNumber(value: Int16(0o755))],
            ofItemAtPath: file.path)
        return (root, file.path)
    }

    private static func makeReport(bins: [String]) -> SkillsStatusReport {
        SkillsStatusReport(
            workspaceDir: "/tmp/workspace",
            managedSkillsDir: "/tmp/skills",
            skills: [
                SkillStatus(
                    name: "test-skill",
                    description: "test",
                    source: "local",
                    filePath: "/tmp/skills/test-skill/SKILL.md",
                    baseDir: "/tmp/skills/test-skill",
                    skillKey: "test-skill",
                    primaryEnv: nil,
                    emoji: nil,
                    homepage: nil,
                    always: false,
                    disabled: false,
                    eligible: true,
                    requirements: SkillRequirements(bins: bins, env: [], config: []),
                    missing: SkillMissing(bins: [], env: [], config: []),
                    configChecks: [],
                    install: []),
            ])
    }
}
