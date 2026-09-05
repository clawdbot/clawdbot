import Darwin
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
            mode: .local))
    }

    @Test func `local mode preserves git checkout node dist gateway command`() {
        let fullCommand = """
        /usr/local/bin/node /Users/dev/Projects/openclaw/dist/index.js gateway --port 18789
        """

        #expect(PortGuardian._testIsExpected(
            command: "node",
            fullCommand: fullCommand,
            mode: .local))
    }

    @Test func `local mode rejects similarly named node project`() {
        #expect(!PortGuardian._testIsExpected(
            command: "node",
            fullCommand: "/usr/local/bin/node /tmp/openclaw-tools/dist/index.js gateway --port 18789",
            mode: .local))
    }

    @Test func `local mode preserves exact launchd pid from renamed checkout`() {
        let fullCommand = """
        /usr/local/bin/node /Users/dev/Projects/openclaw-codex-coexistence-live/dist/index.js gateway --port 18789
        """

        #expect(PortGuardian._testIsExpected(
            command: "node",
            fullCommand: fullCommand,
            mode: .local,
            pid: 4242,
            managedGatewayPID: 4242))
        #expect(!PortGuardian._testIsExpected(
            command: "node",
            fullCommand: fullCommand,
            mode: .local,
            pid: 4242))
    }

    @Test func `local mode rejects stale launchd pid after listener replacement`() {
        #expect(!PortGuardian._testIsExpected(
            command: "node",
            fullCommand: "/tmp/openclaw-tools/dist/index.js gateway --port 18789",
            mode: .local,
            pid: 5252,
            managedGatewayPID: 4242))
    }

    @Test func `local mode rejects unmanaged listener when launchd pid is absent`() {
        #expect(!PortGuardian._testIsExpected(
            command: "node",
            fullCommand: "/tmp/service/dist/index.js gateway --port 18789",
            mode: .local,
            pid: 5252,
            managedGatewayPID: nil))
    }

    @Test func `local mode rejects gateway appearing after another node argument`() {
        #expect(!PortGuardian._testIsExpected(
            command: "node",
            fullCommand: "/usr/local/bin/node --inspect /tmp/openclaw/dist/index.js gateway --port 18789",
            mode: .local))
    }

    @Test func `local mode rejects node dist entrypoint without gateway subcommand`() {
        #expect(!PortGuardian._testIsExpected(
            command: "node",
            fullCommand: "/opt/homebrew/bin/node /opt/homebrew/lib/node_modules/openclaw/dist/index.js doctor",
            mode: .local))
    }

    @Test @MainActor func `remote diagnostics preserve the scanned port after config changes`() async throws {
        let scanned = try Self.reserveNonListeningPort()
        defer { _ = Darwin.close(scanned.fd) }
        let replacement = try Self.reserveNonListeningPort()
        defer { _ = Darwin.close(replacement.fd) }
        try #require(scanned.port != replacement.port)
        let root = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: root) }
        let config = root.appendingPathComponent("openclaw.json")
        try Data(#"{"gateway":{"mode":"remote","port":\#(scanned.port)}}"#.utf8).write(to: config)
        let lsof = root.appendingPathComponent("lsof")
        let script = """
        #!/bin/sh
        set -eu
        config="${0%/*}/openclaw.json"
        test "$OPENCLAW_CONFIG_PATH" = "$config"
        case " $* " in
            *" -iTCP:\(scanned.port) "*) ;;
            *) exit 64 ;;
        esac
        printf '%s\\n' '{"gateway":{"mode":"remote","port":\(replacement.port)}}' > "$config.next"
        /bin/mv "$config.next" "$config"
        printf 'p\(getpid())\\ncssh\\n'
        """
        try script.write(to: lsof, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: lsof.path)

        try await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_CONFIG_PATH": config.path,
                "OPENCLAW_GATEWAY_PORT": nil,
                "PATH": "\(root.path):/usr/bin:/bin:/usr/sbin:/sbin",
            ],
            defaults: ["gatewayPort": nil])
        {
            try #require(GatewayEnvironment.gatewayPort() == scanned.port)
            // Discovery changes config after diagnose captures its port. Both ports
            // stay reserved without listeners, so a health probe cannot hit another test.
            let reports = await PortGuardian.shared.diagnose(mode: .remote)
            let report = try #require(reports.first)
            #expect(reports.count == 1)
            #expect(report.port == scanned.port)
            #expect(GatewayEnvironment.gatewayPort() == replacement.port)
            guard case let .interference(reason, offenders) = report.status else {
                Issue.record("Expected failed scanned-port health, got: \(report.summary)")
                return
            }
            #expect(reason.contains("SSH tunnel is unhealthy"))
            #expect(offenders.map(\.pid) == [getpid()])
        }
    }

    private static func reserveNonListeningPort() throws -> (fd: Int32, port: Int) {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        try #require(fd >= 0)
        do {
            try #require(fcntl(fd, F_SETFD, FD_CLOEXEC) == 0)
            var address = sockaddr_in()
            address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            address.sin_family = sa_family_t(AF_INET)
            address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
            let bound = withUnsafePointer(to: &address) { pointer in
                pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                }
            }
            try #require(bound == 0)
            var length = socklen_t(MemoryLayout<sockaddr_in>.size)
            let resolved = withUnsafeMutablePointer(to: &address) { pointer in
                pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    getsockname(fd, $0, &length)
                }
            }
            try #require(resolved == 0)
            let port = Int(UInt16(bigEndian: address.sin_port))
            try #require(port > 0)
            return (fd, port)
        } catch {
            _ = Darwin.close(fd)
            throw error
        }
    }
}
