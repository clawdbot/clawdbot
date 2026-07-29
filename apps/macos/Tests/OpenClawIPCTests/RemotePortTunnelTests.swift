import Testing
@testable import OpenClaw

#if canImport(Darwin)
import Darwin
import Foundation
import Subprocess

struct RemotePortTunnelTests {
    @Test func `tunnel owns its SSH process instead of multiplexing`() {
        let options = RemotePortTunnel._testSSHOptions(localPort: 28789, remotePort: 18789)

        #expect(options.contains("ControlMaster=no"))
        #expect(options.contains("ControlPath=none"))
        #expect(options.contains("ControlPersist=no"))
        #expect(options.contains("ForkAfterAuthentication=no"))
        #expect(options.contains("28789:127.0.0.1:18789"))
        #expect(options.contains("StrictHostKeyChecking=yes"))
        #expect(options.contains("UpdateHostKeys=yes"))
    }

    @Test func `tunnel requires explicit opt in to use SSH config host key policy`() {
        let options = RemotePortTunnel._testSSHOptions(
            localPort: 28789,
            remotePort: 18789,
            hostKeyPolicy: .openssh)

        #expect(!options.contains { $0.hasPrefix("StrictHostKeyChecking=") })
        #expect(!options.contains { $0.hasPrefix("UpdateHostKeys=") })
    }

    @Test func `drain stderr does not crash when handle closed`() {
        let pipe = Pipe()
        let handle = pipe.fileHandleForReading
        try? handle.close()

        let drained = RemotePortTunnel._testDrainStderr(handle)
        #expect(drained.isEmpty)
    }

    @Test func `process launch failures preserve the executable description`() async {
        let executable = "/tmp/openclaw-missing-process-\(UUID().uuidString)"

        do {
            _ = try await RemotePortTunnel._testStartProcess(
                executable: executable,
                arguments: [])
            Issue.record("expected the missing executable to fail")
        } catch {
            #expect(error.localizedDescription.contains(executable))
        }
    }

    @Test func `termination waits for the original child to exit`() async throws {
        let process = try await RemotePortTunnel._testStartProcess(
            executable: "/bin/sleep",
            arguments: ["30"])
        defer { process.requestTermination() }

        await process.terminate()
        #expect(!process.isRunning)
        #expect(terminatedBySignal(process.terminationStatus, SIGTERM))
    }

    @Test func `instant exits cannot outrun process monitoring`() async throws {
        for _ in 0..<32 {
            let process = try await RemotePortTunnel._testStartProcess(
                executable: "/usr/bin/true",
                arguments: [])
            defer { process.requestTermination() }

            let deadline = ContinuousClock.now + .seconds(1)
            while process.isRunning, ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(1))
            }
            #expect(!process.isRunning)
            await process.terminate()
        }
    }

    @Test func `termination escalates for a TERM-resistant child`() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-tunnel-term-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let readyFile = directory.appendingPathComponent("ready")
        let childPIDFile = directory.appendingPathComponent("child.pid")
        let process = try await RemotePortTunnel._testStartProcess(
            executable: "/bin/sh",
            arguments: [
                "-c",
                """
                /bin/sh -c 'trap "" TERM; echo $$ > "$CHILD_PID_FILE"; while :; do sleep 1; done' &
                while [ ! -s "$CHILD_PID_FILE" ]; do sleep 0.01; done
                echo ready > "$READY_FILE"
                while :; do sleep 1; done
                """,
            ],
            environment: [
                "READY_FILE": readyFile.path,
                "CHILD_PID_FILE": childPIDFile.path,
            ])
        defer { process.requestTermination() }
        let readyDeadline = ContinuousClock.now + .seconds(1)
        while !FileManager.default.fileExists(atPath: readyFile.path),
              ContinuousClock.now < readyDeadline
        {
            usleep(10000)
        }
        #expect(FileManager.default.fileExists(atPath: readyFile.path))
        let childPID = try #require(pid_t(
            String(contentsOf: childPIDFile, encoding: .utf8)
                .trimmingCharacters(in: .whitespacesAndNewlines)))

        let startedAt = ContinuousClock.now
        await process.terminate()

        #expect(ContinuousClock.now - startedAt < .seconds(2))
        #expect(!process.isRunning)
        #expect(terminatedBySignal(process.terminationStatus, SIGTERM))
        #expect(awaitProcessExit(childPID))
    }

    @Test func `port is free detects I pv4 listener`() {
        var fd = socket(AF_INET, SOCK_STREAM, 0)
        #expect(fd >= 0)
        guard fd >= 0 else { return }
        defer {
            if fd >= 0 { _ = Darwin.close(fd) }
        }

        var one: Int32 = 1
        _ = setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, socklen_t(MemoryLayout.size(ofValue: one)))

        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = 0
        addr.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))

        let bound = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.bind(fd, sa, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        #expect(bound == 0)
        guard bound == 0 else { return }
        #expect(Darwin.listen(fd, 1) == 0)

        var name = sockaddr_in()
        var nameLen = socklen_t(MemoryLayout<sockaddr_in>.size)
        let got = withUnsafeMutablePointer(to: &name) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                getsockname(fd, sa, &nameLen)
            }
        }
        #expect(got == 0)
        guard got == 0 else { return }

        let port = UInt16(bigEndian: name.sin_port)
        #expect(RemotePortTunnel._testPortIsFree(port) == false)

        _ = Darwin.close(fd)
        fd = -1

        // In parallel test runs, another test may briefly grab the same ephemeral port.
        // Poll for a short window to avoid flakiness.
        let deadline = Date().addingTimeInterval(0.5)
        var free = false
        while Date() < deadline {
            if RemotePortTunnel._testPortIsFree(port) {
                free = true
                break
            }
            usleep(10000) // 10ms
        }
        #expect(free == true)
    }

    @Test @MainActor func `remote port override prefers explicit remote port`() async {
        let configPath = TestIsolation.tempConfigPath()
        await TestIsolation.withIsolatedState(env: ["OPENCLAW_CONFIG_PATH": configPath]) {
            OpenClawConfigFile.saveDict([
                "gateway": [
                    "remote": [
                        "url": "ws://127.0.0.1:19089",
                        "remotePort": 18789,
                    ],
                ],
            ])

            #expect(RemotePortTunnel._testResolveRemotePortOverride(
                defaultRemotePort: 19089,
                sshHost: "gateway.example") == 18789)
        }
    }

    @Test @MainActor func `remote port override can read loopback url port`() async {
        let configPath = TestIsolation.tempConfigPath()
        await TestIsolation.withIsolatedState(env: ["OPENCLAW_CONFIG_PATH": configPath]) {
            OpenClawConfigFile.saveDict([
                "gateway": [
                    "remote": [
                        "url": "ws://127.0.0.1:18789",
                    ],
                ],
            ])

            #expect(RemotePortTunnel._testResolveRemotePortOverride(
                defaultRemotePort: 19089,
                sshHost: "gateway.example") == 18789)
        }
    }
}

private func awaitProcessExit(_ pid: pid_t) -> Bool {
    let deadline = ContinuousClock.now + .seconds(1)
    while ContinuousClock.now < deadline {
        errno = 0
        if kill(pid, 0) == -1, errno == ESRCH {
            return true
        }
        usleep(10000)
    }
    return false
}

private func terminatedBySignal(_ status: TerminationStatus?, _ signal: Int32) -> Bool {
    guard case let .signaled(code) = status else { return false }
    return code == signal
}
#endif
