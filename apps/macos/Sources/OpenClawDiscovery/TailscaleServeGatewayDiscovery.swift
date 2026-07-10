import Foundation
import OpenClawKit

struct TailscaleServeGatewayBeacon: Equatable {
    var displayName: String
    var tailnetDns: String
    var host: String
    var port: Int
}

enum TailscaleServeGatewayDiscovery {
    private static let maxCandidates = 32
    private static let probeConcurrency = 6
    private static let defaultProbeTimeoutSeconds: TimeInterval = 1.6

    struct DiscoveryContext {
        var tailscaleStatus: @Sendable () async -> String?
        var probeHost: @Sendable (_ host: String, _ timeout: TimeInterval) async -> Bool

        static let live = DiscoveryContext(
            tailscaleStatus: { await readTailscaleStatus() },
            probeHost: { host, timeout in
                await probeHostForGatewayChallenge(host: host, timeout: timeout)
            })
    }

    static func discover(
        timeoutSeconds: TimeInterval = 3.0,
        context: DiscoveryContext = .live) async -> [TailscaleServeGatewayBeacon]
    {
        guard timeoutSeconds > 0 else { return [] }
        guard let statusJson = await context.tailscaleStatus(),
              let status = parseStatus(statusJson)
        else {
            return []
        }

        let candidates = self.collectCandidates(status: status)
        if candidates.isEmpty {
            return []
        }

        let deadline = Date().addingTimeInterval(timeoutSeconds)
        let perProbeTimeout = min(self.defaultProbeTimeoutSeconds, max(0.5, timeoutSeconds * 0.45))

        var byHost: [String: TailscaleServeGatewayBeacon] = [:]
        await withTaskGroup(of: TailscaleServeGatewayBeacon?.self) { group in
            var index = 0
            let workerCount = min(self.probeConcurrency, candidates.count)

            func submitOne() {
                guard index < candidates.count else { return }
                let candidate = candidates[index]
                index += 1
                group.addTask {
                    let remaining = deadline.timeIntervalSinceNow
                    if remaining <= 0 {
                        return nil
                    }
                    let timeout = min(perProbeTimeout, remaining)
                    let reachable = await context.probeHost(candidate.dnsName, timeout)
                    if !reachable {
                        return nil
                    }
                    return TailscaleServeGatewayBeacon(
                        displayName: candidate.displayName,
                        tailnetDns: candidate.dnsName,
                        host: candidate.dnsName,
                        port: 443)
                }
            }

            for _ in 0..<workerCount {
                submitOne()
            }

            while let beacon = await group.next() {
                if let beacon {
                    byHost[beacon.host.lowercased()] = beacon
                }
                submitOne()
            }
        }

        return byHost.values.sorted {
            $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
        }
    }

    private struct Candidate {
        var dnsName: String
        var displayName: String
    }

    private static func collectCandidates(status: TailscaleStatus) -> [Candidate] {
        let selfDns = self.normalizeDnsName(status.selfNode?.dnsName)
        var out: [Candidate] = []
        var seen = Set<String>()

        for node in status.peer.values {
            if node.online == false {
                continue
            }
            guard let dnsName = normalizeDnsName(node.dnsName) else {
                continue
            }
            if dnsName == selfDns {
                continue
            }
            if seen.contains(dnsName) {
                continue
            }
            seen.insert(dnsName)

            out.append(Candidate(
                dnsName: dnsName,
                displayName: self.displayName(hostName: node.hostName, dnsName: dnsName)))

            if out.count >= self.maxCandidates {
                break
            }
        }

        return out
    }

    private static func displayName(hostName: String?, dnsName: String) -> String {
        if let hostName {
            let trimmed = hostName.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                return trimmed
            }
        }
        return dnsName
            .split(separator: ".")
            .first
            .map(String.init) ?? dnsName
    }

    private static func normalizeDnsName(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            return nil
        }
        let withoutDot = trimmed.hasSuffix(".") ? String(trimmed.dropLast()) : trimmed
        let lower = withoutDot.lowercased()
        return lower.isEmpty ? nil : lower
    }

    private static func readTailscaleStatus() async -> String? {
        let candidates = [
            "/usr/local/bin/tailscale",
            "/opt/homebrew/bin/tailscale",
            "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
            "tailscale",
        ]

        for candidate in candidates {
            guard let executable = self.resolveExecutablePath(candidate) else { continue }
            if let stdout = await self.run(path: executable, args: ["status", "--json"], timeout: 1.0) {
                return stdout
            }
        }

        return nil
    }

    static func resolveExecutablePath(
        _ candidate: String,
        env: [String: String] = ProcessInfo.processInfo.environment) -> String?
    {
        let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        let fileManager = FileManager.default
        let hasPathSeparator = trimmed.contains("/")
        if hasPathSeparator {
            return fileManager.isExecutableFile(atPath: trimmed) ? trimmed : nil
        }

        let pathRaw = env["PATH"] ?? ""
        let entries = pathRaw.split(separator: ":").map(String.init)
        for entry in entries {
            let dir = entry.trimmingCharacters(in: .whitespacesAndNewlines)
            if dir.isEmpty {
                continue
            }
            let fullPath = URL(fileURLWithPath: dir)
                .appendingPathComponent(trimmed)
                .path
            if fileManager.isExecutableFile(atPath: fullPath) {
                return fullPath
            }
        }

        return nil
    }

    private static func run(path: String, args: [String], timeout: TimeInterval) async -> String? {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .utility).async {
                continuation.resume(returning: self.runBlocking(path: path, args: args, timeout: timeout))
            }
        }
    }

    private static func runBlocking(path: String, args: [String], timeout: TimeInterval) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = args
        process.environment = self.commandEnvironment()
        let outPipe = Pipe()
        process.standardOutput = outPipe
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
        } catch {
            return nil
        }

        let deadline = Date().addingTimeInterval(timeout)
        while process.isRunning, Date() < deadline {
            Thread.sleep(forTimeInterval: 0.02)
        }
        if process.isRunning {
            process.terminate()
        }
        process.waitUntilExit()

        let data = (try? outPipe.fileHandleForReading.readToEnd()) ?? Data()
        let output = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return output?.isEmpty == false ? output : nil
    }

    static func commandEnvironment(
        base: [String: String] = ProcessInfo.processInfo.environment) -> [String: String]
    {
        var env = base
        let term = env["TERM"]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if term.isEmpty {
            // The macOS Tailscale app binary exits with CLIError error 3 when TERM is missing,
            // which is common for GUI-launched app environments.
            env["TERM"] = "dumb"
        }
        return env
    }

    private static func parseStatus(_ raw: String) -> TailscaleStatus? {
        guard let data = raw.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(TailscaleStatus.self, from: data)
    }

    private static func probeHostForGatewayChallenge(host: String, timeout: TimeInterval) async -> Bool {
        var components = URLComponents()
        components.scheme = "wss"
        components.host = host
        guard let url = components.url else { return false }

        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = max(0.5, timeout)
        config.timeoutIntervalForResource = max(0.5, timeout)
        let session = URLSession(configuration: config)
        let task = session.webSocketTask(with: url)
        task.resume()

        defer {
            task.cancel(with: .goingAway, reason: nil)
            session.invalidateAndCancel()
        }

        do {
            return try await AsyncTimeout.withTimeout(
                seconds: timeout,
                onTimeout: { NSError(domain: "TailscaleServeDiscovery", code: 1, userInfo: nil) },
                operation: {
                    while true {
                        let message = try await task.receive()
                        if self.isConnectChallenge(message: message) {
                            return true
                        }
                    }
                })
        } catch {
            return false
        }
    }

    private static func isConnectChallenge(message: URLSessionWebSocketTask.Message) -> Bool {
        let data: Data
        switch message {
        case let .data(value):
            data = value
        case let .string(value):
            guard let encoded = value.data(using: .utf8) else { return false }
            data = encoded
        @unknown default:
            return false
        }

        guard let object = try? JSONSerialization.jsonObject(with: data),
              let dict = object as? [String: Any],
              let type = dict["type"] as? String,
              type == "event",
              let event = dict["event"] as? String
        else {
            return false
        }

        return event == "connect.challenge"
    }
}

private struct TailscaleStatus: Decodable {
    struct Node: Decodable {
        let dnsName: String?
        let hostName: String?
        let online: Bool?

        private enum CodingKeys: String, CodingKey {
            case dnsName = "DNSName"
            case hostName = "HostName"
            case online = "Online"
        }
    }

    let selfNode: Node?
    let peer: [String: Node]

    private enum CodingKeys: String, CodingKey {
        case selfNode = "Self"
        case peer = "Peer"
    }
}
