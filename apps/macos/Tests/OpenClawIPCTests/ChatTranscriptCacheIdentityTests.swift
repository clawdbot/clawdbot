import Foundation
import Testing
@testable import OpenClaw

struct ChatTranscriptCacheIdentityTests {
    private static let defaultStateDir = URL(fileURLWithPath: "/Users/tester/.openclaw", isDirectory: true)

    @Test func `unconfigured mode has no cache identity`() {
        let id = MacChatTranscriptCache.gatewayID(
            mode: .unconfigured,
            localStateDir: Self.defaultStateDir,
            remoteTransport: .ssh,
            directURL: nil,
            sshTarget: "user@host",
            sshRemotePort: 18789)
        #expect(id == nil)
    }

    @Test @MainActor func `windows share one outbox owner per gateway`() {
        let databaseURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-cache-owner-\(UUID().uuidString).sqlite")
        let gatewayID = "gw-shared-\(UUID().uuidString)"
        let first = MacChatTranscriptCache.store(databaseURL: databaseURL, gatewayID: gatewayID)
        let second = MacChatTranscriptCache.store(databaseURL: databaseURL, gatewayID: gatewayID)

        #expect(first === second)
    }

    @Test func `local mode keys on state dir so profiles never collide`() {
        let defaultProfile = MacChatTranscriptCache.gatewayID(
            mode: .local,
            localStateDir: Self.defaultStateDir,
            remoteTransport: .ssh,
            directURL: nil,
            sshTarget: "",
            sshRemotePort: 18789)
        let devProfile = MacChatTranscriptCache.gatewayID(
            mode: .local,
            localStateDir: URL(fileURLWithPath: "/Users/tester/.openclaw-dev", isDirectory: true),
            remoteTransport: .ssh,
            directURL: nil,
            sshTarget: "",
            sshRemotePort: 18789)
        #expect(defaultProfile == "local:/Users/tester/.openclaw")
        #expect(devProfile == "local:/Users/tester/.openclaw-dev")
        #expect(defaultProfile != devProfile)
    }

    @Test func `local state dir aliases resolve to one identity`() throws {
        // macOS tmp lives behind a /var -> /private/var symlink; both spellings
        // of the same state dir must map to a single cache scope.
        let canonical = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-cache-identity-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: canonical, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: canonical) }
        let resolved = canonical.resolvingSymlinksInPath()
        let viaSymlink = MacChatTranscriptCache.gatewayID(
            mode: .local,
            localStateDir: canonical,
            remoteTransport: .ssh,
            directURL: nil,
            sshTarget: "",
            sshRemotePort: 18789)
        let viaResolved = MacChatTranscriptCache.gatewayID(
            mode: .local,
            localStateDir: resolved,
            remoteTransport: .ssh,
            directURL: nil,
            sshTarget: "",
            sshRemotePort: 18789)
        #expect(viaSymlink == viaResolved)
    }

    @Test func `remote direct keys on the full canonical url`() {
        let explicitPort = MacChatTranscriptCache.gatewayID(
            mode: .remote,
            localStateDir: Self.defaultStateDir,
            remoteTransport: .direct,
            directURL: URL(string: "ws://Gateway.Example.com:9001"),
            sshTarget: "",
            sshRemotePort: 18789)
        #expect(explicitPort == "remote:ws://gateway.example.com:9001")

        let defaultWSSPort = MacChatTranscriptCache.gatewayID(
            mode: .remote,
            localStateDir: Self.defaultStateDir,
            remoteTransport: .direct,
            directURL: URL(string: "wss://gw.example.com"),
            sshTarget: "",
            sshRemotePort: 18789)
        #expect(defaultWSSPort == "remote:wss://gw.example.com:443")

        // One origin can route to several gateways by path; each path is its
        // own cache scope.
        let teamA = MacChatTranscriptCache.gatewayID(
            mode: .remote,
            localStateDir: Self.defaultStateDir,
            remoteTransport: .direct,
            directURL: URL(string: "wss://gw.example.com/team-a"),
            sshTarget: "",
            sshRemotePort: 18789)
        let teamB = MacChatTranscriptCache.gatewayID(
            mode: .remote,
            localStateDir: Self.defaultStateDir,
            remoteTransport: .direct,
            directURL: URL(string: "wss://gw.example.com/team-b"),
            sshTarget: "",
            sshRemotePort: 18789)
        #expect(teamA == "remote:wss://gw.example.com:443/team-a")
        #expect(teamB == "remote:wss://gw.example.com:443/team-b")
        #expect(teamA != teamB)

        // Percent-encoded path spelling is part of the request URL and must
        // not collapse into the decoded form's scope.
        let encodedPath = MacChatTranscriptCache.gatewayID(
            mode: .remote,
            localStateDir: Self.defaultStateDir,
            remoteTransport: .direct,
            directURL: URL(string: "wss://gw.example.com/team%2Fa"),
            sshTarget: "",
            sshRemotePort: 18789)
        let decodedPath = MacChatTranscriptCache.gatewayID(
            mode: .remote,
            localStateDir: Self.defaultStateDir,
            remoteTransport: .direct,
            directURL: URL(string: "wss://gw.example.com/team/a"),
            sshTarget: "",
            sshRemotePort: 18789)
        #expect(encodedPath == "remote:wss://gw.example.com:443/team%2Fa")
        #expect(encodedPath != decodedPath)

        let missingURL = MacChatTranscriptCache.gatewayID(
            mode: .remote,
            localStateDir: Self.defaultStateDir,
            remoteTransport: .direct,
            directURL: nil,
            sshTarget: "",
            sshRemotePort: 18789)
        #expect(missingURL == nil)
    }

    @Test func `remote ssh keys on the ssh target and remote gateway port`() {
        let id = MacChatTranscriptCache.gatewayID(
            mode: .remote,
            localStateDir: Self.defaultStateDir,
            remoteTransport: .ssh,
            directURL: nil,
            sshTarget: "  user@studio.local  ",
            sshRemotePort: 18789)
        #expect(id == "ssh:user@studio.local:18789")

        // One SSH target can front several gateways on different remote ports;
        // each must get its own cache scope.
        let otherGateway = MacChatTranscriptCache.gatewayID(
            mode: .remote,
            localStateDir: Self.defaultStateDir,
            remoteTransport: .ssh,
            directURL: nil,
            sshTarget: "user@studio.local",
            sshRemotePort: 19001)
        #expect(otherGateway == "ssh:user@studio.local:19001")
        #expect(otherGateway != id)

        let missingTarget = MacChatTranscriptCache.gatewayID(
            mode: .remote,
            localStateDir: Self.defaultStateDir,
            remoteTransport: .ssh,
            directURL: nil,
            sshTarget: "   ",
            sshRemotePort: 18789)
        #expect(missingTarget == nil)
    }
}
