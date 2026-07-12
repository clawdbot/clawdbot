import AppKit
import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct LowCoverageHelperTests {
    private typealias ProtoAnyCodable = OpenClawProtocol.AnyCodable

    @Test func `any codable helper accessors`() throws {
        let payload: [String: ProtoAnyCodable] = [
            "title": ProtoAnyCodable("Hello"),
            "flag": ProtoAnyCodable(true),
            "count": ProtoAnyCodable(3),
            "ratio": ProtoAnyCodable(1.25),
            "list": ProtoAnyCodable([ProtoAnyCodable("a"), ProtoAnyCodable(2)]),
        ]
        let any = ProtoAnyCodable(payload)
        let dict = try #require(any.dictionaryValue)
        #expect(dict["title"]?.stringValue == "Hello")
        #expect(dict["flag"]?.boolValue == true)
        #expect(dict["count"]?.intValue == 3)
        #expect(dict["ratio"]?.doubleValue == 1.25)
        #expect(dict["list"]?.arrayValue?.count == 2)

        let foundation = any.foundationValue as? [String: Any]
        #expect((foundation?["title"] as? String) == "Hello")
    }

    @Test func `attributed string strips foreground color`() {
        let text = NSMutableAttributedString(string: "Test")
        text.addAttribute(.foregroundColor, value: NSColor.red, range: NSRange(location: 0, length: 4))
        let stripped = text.strippingForegroundColor()
        let color = stripped.attribute(.foregroundColor, at: 0, effectiveRange: nil)
        #expect(color == nil)
    }

    @Test func `shell executor handles empty command`() async {
        let result = await ShellExecutor.runDetailed(command: [], cwd: nil, env: nil, timeout: nil)
        #expect(result.success == false)
        #expect(result.errorMessage != nil)
    }

    @Test func `shell executor runs command`() async {
        let result = await ShellExecutor.runDetailed(command: ["/bin/echo", "ok"], cwd: nil, env: nil, timeout: 2)
        #expect(result.success == true)
        #expect(result.stdout.contains("ok") || result.stderr.contains("ok"))
    }

    @Test func `shell executor times out`() async {
        for _ in 0..<10 {
            let result = await ShellExecutor.runDetailed(
                command: ["/bin/sleep", "1"],
                cwd: nil,
                env: nil,
                timeout: 0.01)
            #expect(result.timedOut == true)
        }
    }

    @Test func `shell executor drains stdout and stderr`() async {
        let script = """
        i=0
        while [ $i -lt 2000 ]; do
          echo "stdout-$i"
          echo "stderr-$i" 1>&2
          i=$((i+1))
        done
        """
        let result = await ShellExecutor.runDetailed(
            command: ["/bin/sh", "-c", script],
            cwd: nil,
            env: nil,
            timeout: 2)
        #expect(result.success == true)
        #expect(result.stdout.contains("stdout-1999"))
        #expect(result.stderr.contains("stderr-1999"))
    }

    @Test func `shell executor finishes when a descendant retains output handles`() async {
        let startedAt = ContinuousClock.now
        let result = await ShellExecutor.runDetailed(
            command: ["/bin/sh", "-c", "sleep 5 & echo ready"],
            cwd: nil,
            env: nil,
            timeout: 1)

        #expect(result.success == true)
        #expect(result.stdout.contains("ready"))
        #expect(ContinuousClock.now - startedAt < .seconds(2))
    }

    @Test func `node info codable round trip`() throws {
        let info = NodeInfo(
            nodeId: "node-1",
            displayName: "Node One",
            platform: "macOS",
            version: "1.0",
            coreVersion: "1.0-core",
            uiVersion: "1.0-ui",
            deviceFamily: "Mac",
            modelIdentifier: "MacBookPro",
            remoteIp: "192.168.1.2",
            caps: ["chat"],
            commands: ["send"],
            permissions: ["send": true],
            paired: true,
            connected: false)
        let data = try JSONEncoder().encode(info)
        let decoded = try JSONDecoder().decode(NodeInfo.self, from: data)
        #expect(decoded.nodeId == "node-1")
        #expect(decoded.isPaired == true)
        #expect(decoded.isConnected == false)
    }

    @Test @MainActor func `presence reporter helpers`() {
        let summary = PresenceReporter._testComposePresenceSummary(mode: "local", reason: "test")
        #expect(summary.contains("mode local"))
        #expect(!PresenceReporter._testAppVersionString().isEmpty)
        #expect(!PresenceReporter._testPlatformString().isEmpty)
        _ = PresenceReporter._testLastInputSeconds()
        _ = PresenceReporter._testPrimaryIPv4Address()
    }

    @Test func `port guardian parses listeners and builds reports`() {
        let output = """
        p123
        cnode
        uuser
        p456
        cssh
        uroot
        """
        let listeners = PortGuardian._testParseListeners(output)
        #expect(listeners.count == 2)
        #expect(listeners[0].command == "node")
        #expect(listeners[1].command == "ssh")

        let okReport = PortGuardian._testBuildReport(
            port: 18789,
            mode: .local,
            listeners: [(pid: 1, command: "node", fullCommand: "node", user: "me")])
        #expect(okReport.offenders.isEmpty)

        let badReport = PortGuardian._testBuildReport(
            port: 18789,
            mode: .local,
            listeners: [(pid: 2, command: "python", fullCommand: "python", user: "me")])
        #expect(!badReport.offenders.isEmpty)

        let emptyReport = PortGuardian._testBuildReport(port: 18789, mode: .local, listeners: [])
        #expect(emptyReport.summary.contains("Nothing is listening"))
    }

    @Test func `port guardian remote mode does not kill docker`() {
        let port = GatewayEnvironment.gatewayPort()

        #expect(PortGuardian._testIsExpected(
            command: "com.docker.backend",
            fullCommand: "com.docker.backend",
            port: port, mode: .remote) == true)

        #expect(PortGuardian._testIsExpected(
            command: "ssh",
            fullCommand: "ssh -L \(port):localhost:\(port) user@host",
            port: port, mode: .remote) == true)

        #expect(PortGuardian._testIsExpected(
            command: "podman",
            fullCommand: "podman",
            port: port, mode: .remote) == true)
    }

    @Test func `port guardian local mode still rejects unexpected`() {
        #expect(PortGuardian._testIsExpected(
            command: "com.docker.backend",
            fullCommand: "com.docker.backend",
            port: 18789, mode: .local) == false)

        #expect(PortGuardian._testIsExpected(
            command: "python",
            fullCommand: "python server.py",
            port: 18789, mode: .local) == false)

        #expect(PortGuardian._testIsExpected(
            command: "node",
            fullCommand: "openclaw-gateway",
            port: 18789, mode: .local) == true)

        #expect(PortGuardian._testIsExpected(
            command: "node",
            fullCommand: "node /path/to/gateway-daemon",
            port: 18789, mode: .local) == true)
    }

    @Test func `port guardian remote mode report accepts any listener`() {
        let dockerReport = PortGuardian._testBuildReport(
            port: 18789, mode: .remote,
            listeners: [(
                pid: 99,
                command: "com.docker.backend",
                fullCommand: "com.docker.backend",
                user: "me")])
        #expect(dockerReport.offenders.isEmpty)

        let localDockerReport = PortGuardian._testBuildReport(
            port: 18789, mode: .local,
            listeners: [(
                pid: 99,
                command: "com.docker.backend",
                fullCommand: "com.docker.backend",
                user: "me")])
        #expect(!localDockerReport.offenders.isEmpty)
    }

    @Test func `port guardian matches only its own ssh tunnel command`() {
        let full = "/usr/bin/ssh -o BatchMode=yes -o ControlMaster=no -o ControlPath=none "
            + "-o ExitOnForwardFailure=yes -n -N -L 18789:127.0.0.1:18789 -- user@host"
        #expect(PortGuardian.isTunnelCommand(full, localPort: 18789))
        #expect(PortGuardian.isTunnelCommand("ssh -N -L18789:127.0.0.1:18789 user@host", localPort: 18789))

        // Wrong local port, missing -N (interactive forward), other binaries, or a
        // forward to a non-loopback host are not ours to kill.
        #expect(!PortGuardian.isTunnelCommand(full, localPort: 18790))
        #expect(!PortGuardian.isTunnelCommand("ssh -L 18789:127.0.0.1:18789 user@host", localPort: 18789))
        #expect(!PortGuardian.isTunnelCommand("ssh -N -L 18789:example.com:80 user@host", localPort: 18789))
        #expect(!PortGuardian.isTunnelCommand("sshd: user [priv]", localPort: 18789))
        #expect(!PortGuardian.isTunnelCommand("node server.js -N -L 18789:127.0.0.1:18789", localPort: 18789))
        #expect(!PortGuardian.isTunnelCommand("", localPort: 18789))
    }

    @Test func `port guardian classifies tunnel records for reaping`() {
        let recordedAt: TimeInterval = 1_000_000
        let record = PortGuardian.Record(
            port: 18789, pid: 4242, command: "/usr/bin/ssh", mode: "remote", timestamp: recordedAt)
        let tunnel = "/usr/bin/ssh -o BatchMode=yes -n -N -L 18789:127.0.0.1:18789 -- user@host"
        let spawnedBeforeRecord = recordedAt - 2

        // Process gone → stale record.
        #expect(PortGuardian.classifyTunnelRecord(record, process: nil) == .drop)
        // Pid reused by an unrelated process → drop the record, never kill.
        #expect(PortGuardian.classifyTunnelRecord(
            record,
            process: .init(parentPid: 1, startedAt: spawnedBeforeRecord, fullCommand: "node server.js"))
            == .drop)
        // Pid reused by a look-alike tunnel started after the record was written →
        // different process, drop without killing.
        #expect(PortGuardian.classifyTunnelRecord(
            record,
            process: .init(parentPid: 1, startedAt: recordedAt + 3600, fullCommand: tunnel)) == .drop)
        // Reparented to launchd → owning app instance died → reap.
        #expect(PortGuardian.classifyTunnelRecord(
            record,
            process: .init(parentPid: 1, startedAt: spawnedBeforeRecord, fullCommand: tunnel)) == .reap)
        // Parent alive (e.g. a concurrent OpenClaw instance) → hands off.
        #expect(PortGuardian.classifyTunnelRecord(
            record,
            process: .init(parentPid: 987, startedAt: spawnedBeforeRecord, fullCommand: tunnel)) == .keep)
        // Command unreadable → cannot prove ownership → keep.
        #expect(PortGuardian.classifyTunnelRecord(
            record,
            process: .init(parentPid: 1, startedAt: spawnedBeforeRecord, fullCommand: nil)) == .keep)
    }

    @Test func `port guardian reap plan merges disk records and drops stale ones`() {
        func record(pid: Int32, port: Int, timestamp: TimeInterval) -> PortGuardian.Record {
            PortGuardian.Record(
                port: port, pid: pid, command: "/usr/bin/ssh", mode: "remote", timestamp: timestamp)
        }
        func tunnel(port: Int) -> String {
            "/usr/bin/ssh -o BatchMode=yes -n -N -L \(port):127.0.0.1:18789 -- user@host"
        }

        // pid 10: our live tunnel (parent alive). Disk-only records from a crashed
        // sibling instance: pid 20 orphaned, pid 30 already gone.
        let own = [record(pid: 10, port: 18790, timestamp: 300)]
        let disk = [
            record(pid: 20, port: 18789, timestamp: 100),
            record(pid: 30, port: 18791, timestamp: 200),
            record(pid: 10, port: 1, timestamp: 1), // superseded by the own record
        ]
        let plan = PortGuardian.planTunnelReap(own: own, disk: disk, processInfo: { pid in
            switch pid {
            case 10: .init(parentPid: 987, startedAt: 299, fullCommand: tunnel(port: 18790))
            case 20: .init(parentPid: 1, startedAt: 99, fullCommand: tunnel(port: 18789))
            default: nil
            }
        })
        #expect(plan.reap.map(\.pid) == [20])
        #expect(plan.keep.map(\.pid) == [10])
        #expect(plan.keep.first?.port == 18790)
        // The dead pid 30 is reported as a drop; the shadowed pid-10 disk record is
        // superseded, not dropped, so a reap cycle cannot delete the fresh record.
        #expect(plan.drop.map(\.pid) == [30])
    }

    @Test func `port guardian classifies a real orphaned tunnel process for reaping`() async throws {
        // Real ssh that hangs safely: ProxyCommand replaces the TCP transport, so no
        // network traffic happens and the -L port is never bound (forwards only bind
        // after auth). Spawned through sh so the parent exits and ssh reparents to
        // launchd — the exact orphan shape the reaper must detect.
        let port = 45871
        // Detach the child's stdio: the pipe must reach EOF when sh exits, not when ssh dies.
        let script = "/usr/bin/ssh -o BatchMode=yes -o ProxyCommand='sleep 60' " +
            "-N -L \(port):127.0.0.1:\(port) orphan-reap-test-host >/dev/null 2>&1 & echo $!"
        let spawn = Process()
        spawn.executableURL = URL(fileURLWithPath: "/bin/sh")
        spawn.arguments = ["-c", script]
        let out = Pipe()
        spawn.standardOutput = out
        try spawn.run()
        spawn.waitUntilExit()
        let pidText = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let pid = try #require(Int32(pidText.trimmingCharacters(in: .whitespacesAndNewlines)))
        defer { kill(pid, SIGKILL) }

        // Reparenting to launchd is immediate once sh exits, but give ps/sysctl a beat.
        var info: PortGuardian.TunnelProcessInfo?
        for _ in 0..<40 {
            info = PortGuardian._testTunnelProcessInfo(pid: pid)
            if info?.parentPid == 1, info?.fullCommand?.isEmpty == false { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        let orphan = try #require(info)
        #expect(orphan.parentPid == 1)
        // Kernel start time must be sane so the pid-reuse gate can rely on it.
        #expect(abs(orphan.startedAt - Date().timeIntervalSince1970) < 60)
        let recordedAt = Date().timeIntervalSince1970
        let record = PortGuardian.Record(
            port: port, pid: pid, command: "/usr/bin/ssh", mode: "remote", timestamp: recordedAt)
        #expect(PortGuardian.classifyTunnelRecord(record, process: orphan) == .reap)

        // Same process under a different recorded port must never be reap-eligible.
        let mismatched = PortGuardian.Record(
            port: port + 1, pid: pid, command: "/usr/bin/ssh", mode: "remote", timestamp: recordedAt)
        #expect(PortGuardian.classifyTunnelRecord(mismatched, process: orphan) == .drop)

        // A record predating this process (reused pid) must drop, not reap.
        let predates = PortGuardian.Record(
            port: port, pid: pid, command: "/usr/bin/ssh", mode: "remote",
            timestamp: orphan.startedAt - 3600)
        #expect(PortGuardian.classifyTunnelRecord(predates, process: orphan) == .drop)
    }

    @Test @MainActor func `canvas scheme handler resolves files and errors`() throws {
        let root = FileManager().temporaryDirectory
            .appendingPathComponent("canvas-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: root) }
        try FileManager().createDirectory(at: root, withIntermediateDirectories: true)
        let session = root.appendingPathComponent("main", isDirectory: true)
        try FileManager().createDirectory(at: session, withIntermediateDirectories: true)

        let index = session.appendingPathComponent("index.html")
        try "<h1>Hello</h1>".write(to: index, atomically: true, encoding: .utf8)

        let handler = CanvasSchemeHandler(root: root)
        let url = try #require(CanvasScheme.makeURL(session: "main", path: "index.html"))
        let response = handler._testResponse(for: url)
        #expect(response.mime == "text/html")
        #expect(String(data: response.data, encoding: .utf8)?.contains("Hello") == true)

        let invalid = try #require(URL(string: "https://example.com"))
        let invalidResponse = handler._testResponse(for: invalid)
        #expect(invalidResponse.mime == "text/html")

        let missing = try #require(CanvasScheme.makeURL(session: "missing", path: "/"))
        let missingResponse = handler._testResponse(for: missing)
        #expect(missingResponse.mime == "text/html")

        #expect(handler._testTextEncodingName(for: "text/html") == "utf-8")
        #expect(handler._testTextEncodingName(for: "application/octet-stream") == nil)
    }

    @Test @MainActor func `canvas scheme handler blocks symlink escapes`() throws {
        let root = FileManager().temporaryDirectory
            .appendingPathComponent("canvas-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: root) }
        try FileManager().createDirectory(at: root, withIntermediateDirectories: true)

        let session = root.appendingPathComponent("main", isDirectory: true)
        try FileManager().createDirectory(at: session, withIntermediateDirectories: true)

        let outside = root.deletingLastPathComponent().appendingPathComponent("canvas-secret-\(UUID().uuidString).txt")
        defer { try? FileManager().removeItem(at: outside) }
        try "top-secret".write(to: outside, atomically: true, encoding: .utf8)

        let symlink = session.appendingPathComponent("index.html")
        try FileManager().createSymbolicLink(at: symlink, withDestinationURL: outside)

        let handler = CanvasSchemeHandler(root: root)
        let url = try #require(CanvasScheme.makeURL(session: "main", path: "index.html"))
        let response = handler._testResponse(for: url)
        let body = String(data: response.data, encoding: .utf8) ?? ""

        #expect(response.mime == "text/html")
        #expect(body.contains("Forbidden"))
        #expect(!body.contains("top-secret"))
    }

    @Test @MainActor func `canvas window helper functions`() throws {
        #expect(CanvasWindowController._testSanitizeSessionKey("  main ") == "main")
        #expect(CanvasWindowController._testSanitizeSessionKey("bad/..") == "bad___")
        #expect(CanvasWindowController._testJSOptionalStringLiteral(nil) == "null")

        let rect = NSRect(x: 10, y: 12, width: 400, height: 420)
        let key = CanvasWindowController._testStoredFrameKey(sessionKey: "test")
        let loaded = CanvasWindowController._testStoreAndLoadFrame(sessionKey: "test", frame: rect)
        UserDefaults.standard.removeObject(forKey: key)
        #expect(loaded?.size.width == rect.size.width)

        let trusted = try #require(URL(string:
            "http://127.0.0.1:18789/__openclaw__/cap/token/__openclaw__/a2ui/?platform=macos"))
        #expect(CanvasA2UIActionMessageHandler.isTrustedSourceURL(trusted, expectedRemoteURL: trusted))
    }
}
