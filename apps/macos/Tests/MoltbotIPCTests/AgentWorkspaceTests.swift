import Foundation
import Testing
@testable import Moltbot

@Suite
struct AgentWorkspaceTests {
    @Test
    func displayPathUsesTildeForHome() {
        let home = FileManager().homeDirectoryForCurrentUser
        #expect(AgentWorkspace.displayPath(for: home) == "~")

        let inside = home.appendingPathComponent("Projects", isDirectory: true)
        #expect(AgentWorkspace.displayPath(for: inside).hasPrefix("~/"))
    }

    @Test
    func resolveWorkspaceURLExpandsTilde() {
        let url = AgentWorkspace.resolveWorkspaceURL(from: "~/tmp")
        #expect(url.path.hasSuffix("/tmp"))
    }

    @Test
    func agentsURLAppendsFilename() {
        let root = URL(fileURLWithPath: "/tmp/ws", isDirectory: true)
        let url = AgentWorkspace.agentsURL(workspaceURL: root)
        #expect(url.lastPathComponent == AgentWorkspace.agentsFilename)
    }

    @Test
    func bootstrapCreatesAgentsFileWhenMissing() throws {
        let tmp = FileManager().temporaryDirectory
            .appendingPathComponent("moltbot-ws-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: tmp) }

        let agentsURL = try AgentWorkspace.bootstrap(workspaceURL: tmp)
        #expect(FileManager().fileExists(atPath: agentsURL.path))

        let contents = try String(contentsOf: agentsURL, encoding: .utf8)
        #expect(contents.contains("# AGENTS.md"))

        let identityURL = tmp.appendingPathComponent(AgentWorkspace.identityFilename)
        let userURL = tmp.appendingPathComponent(AgentWorkspace.userFilename)
        let bootstrapURL = tmp.appendingPathComponent(AgentWorkspace.bootstrapFilename)
        #expect(FileManager().fileExists(atPath: identityURL.path))
        #expect(FileManager().fileExists(atPath: userURL.path))
        #expect(FileManager().fileExists(atPath: bootstrapURL.path))

        let second = try AgentWorkspace.bootstrap(workspaceURL: tmp)
        #expect(second == agentsURL)
    }

    @Test
    func bootstrapSafetyRejectsNonEmptyFolderWithoutAgents() throws {
        let tmp = FileManager().temporaryDirectory
            .appendingPathComponent("moltbot-ws-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: tmp) }
        try FileManager().createDirectory(at: tmp, withIntermediateDirectories: true)
        let marker = tmp.appendingPathComponent("notes.txt")
        try "hello".write(to: marker, atomically: true, encoding: .utf8)

        let result = AgentWorkspace.bootstrapSafety(for: tmp)
        switch result {
        case .unsafe:
            break
        case .safe:
            #expect(Bool(false), "Expected unsafe bootstrap safety result.")
        }
    }

    @Test
    func bootstrapSafetyAllowsExistingAgentsFile() throws {
        let tmp = FileManager().temporaryDirectory
            .appendingPathComponent("moltbot-ws-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: tmp) }
        try FileManager().createDirectory(at: tmp, withIntermediateDirectories: true)
        let agents = tmp.appendingPathComponent(AgentWorkspace.agentsFilename)
        try "# AGENTS.md".write(to: agents, atomically: true, encoding: .utf8)

        let result = AgentWorkspace.bootstrapSafety(for: tmp)
        switch result {
        case .safe:
            break
        case .unsafe:
            #expect(Bool(false), "Expected safe bootstrap safety result.")
        }
    }

    @Test
    func bootstrapSkipsBootstrapFileWhenWorkspaceHasContent() throws {
        let tmp = FileManager().temporaryDirectory
            .appendingPathComponent("moltbot-ws-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: tmp) }
        try FileManager().createDirectory(at: tmp, withIntermediateDirectories: true)
        let marker = tmp.appendingPathComponent("notes.txt")
        try "hello".write(to: marker, atomically: true, encoding: .utf8)

        _ = try AgentWorkspace.bootstrap(workspaceURL: tmp)

        let bootstrapURL = tmp.appendingPathComponent(AgentWorkspace.bootstrapFilename)
        #expect(!FileManager().fileExists(atPath: bootstrapURL.path))
    }

    @Test
    func needsBootstrapFalseWhenIdentityAlreadySet() throws {
        let tmp = FileManager().temporaryDirectory
            .appendingPathComponent("moltbot-ws-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: tmp) }
        try FileManager().createDirectory(at: tmp, withIntermediateDirectories: true)
        let identityURL = tmp.appendingPathComponent(AgentWorkspace.identityFilename)
        try """
        # IDENTITY.md - Agent Identity

        - Name: Clawd
        - Creature: Space Lobster
        - Vibe: Helpful
        - Emoji: lobster
        """.write(to: identityURL, atomically: true, encoding: .utf8)
        let bootstrapURL = tmp.appendingPathComponent(AgentWorkspace.bootstrapFilename)
        try "bootstrap".write(to: bootstrapURL, atomically: true, encoding: .utf8)

        #expect(!AgentWorkspace.needsBootstrap(workspaceURL: tmp))
    }
}
