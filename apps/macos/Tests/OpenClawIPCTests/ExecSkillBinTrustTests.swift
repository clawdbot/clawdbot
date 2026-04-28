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
