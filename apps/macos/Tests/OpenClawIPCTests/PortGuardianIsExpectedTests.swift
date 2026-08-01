import Foundation
import Testing
@testable import OpenClaw

struct PortGuardianIsExpectedTests {
    @Test func `local mode preserves launchd node dist gateway command`() {
        let fullCommand = """
        /opt/homebrew/bin/node /opt/homebrew/lib/node_modules/openclaw/dist/index.js gateway --port 18789 --bind loopback
        """

        #expect(PortGuardian._testIsExpected(
            command: "node",
            fullCommand: fullCommand,
            port: 18789,
            mode: .local))
    }

    @Test func `local mode preserves git checkout node dist gateway command`() {
        let fullCommand = """
        /usr/local/bin/node /Users/dev/Projects/openclaw/dist/index.js gateway --port 18789
        """

        #expect(PortGuardian._testIsExpected(
            command: "node",
            fullCommand: fullCommand,
            port: 18789,
            mode: .local))
    }

    @Test func `local mode rejects similarly named node project`() {
        #expect(!PortGuardian._testIsExpected(
            command: "node",
            fullCommand: "/usr/local/bin/node /tmp/openclaw-tools/dist/index.js gateway --port 18789",
            port: 18789,
            mode: .local))
    }

    @Test func `local mode preserves exact launchd pid from renamed checkout`() {
        let fullCommand = """
        /usr/local/bin/node /Users/dev/Projects/openclaw-codex-coexistence-live/dist/index.js gateway --port 18789
        """

        #expect(PortGuardian._testIsExpected(
            command: "node",
            fullCommand: fullCommand,
            port: 18789,
            mode: .local,
            pid: 4242,
            managedGatewayPID: 4242))
        #expect(!PortGuardian._testIsExpected(
            command: "node",
            fullCommand: fullCommand,
            port: 18789,
            mode: .local,
            pid: 4242))
    }

    @Test func `local mode rejects stale launchd pid after listener replacement`() {
        #expect(!PortGuardian._testIsExpected(
            command: "node",
            fullCommand: "/tmp/openclaw-tools/dist/index.js gateway --port 18789",
            port: 18789,
            mode: .local,
            pid: 5252,
            managedGatewayPID: 4242))
    }

    @Test func `local mode rejects unmanaged listener when launchd pid is absent`() {
        #expect(!PortGuardian._testIsExpected(
            command: "node",
            fullCommand: "/tmp/service/dist/index.js gateway --port 18789",
            port: 18789,
            mode: .local,
            pid: 5252,
            managedGatewayPID: nil))
    }

    @Test func `local mode rejects gateway appearing after another node argument`() {
        #expect(!PortGuardian._testIsExpected(
            command: "node",
            fullCommand: "/usr/local/bin/node --inspect /tmp/openclaw/dist/index.js gateway --port 18789",
            port: 18789,
            mode: .local))
    }

    @Test func `local mode rejects node dist entrypoint without gateway subcommand`() {
        #expect(!PortGuardian._testIsExpected(
            command: "node",
            fullCommand: "/opt/homebrew/bin/node /opt/homebrew/lib/node_modules/openclaw/dist/index.js doctor",
            port: 18789,
            mode: .local))
    }
}
