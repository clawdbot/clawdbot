import MoltbotKit
import Foundation

struct WideAreaGatewayBeacon: Sendable, Equatable {
    var instanceName: String
    var displayName: String
    var host: String
    var port: Int
    var lanHost: String?
    var tailnetDns: String?
    var gatewayPort: Int?
    var sshPort: Int?
    var cliPath: String?
}

enum WideAreaGatewayDiscovery {
    private static let maxCandidates = 40
    private static let digPath = "/usr/bin/dig"
    private static let defaultTimeoutSeconds: TimeInterval = 0.2
    private static let nameserverProbeConcurrency = 6

    struct DiscoveryContext: Sendable {
        var tailscaleStatus: @Sendable () -> String?
        var dig: @Sendable (_ args: [String], _ timeout: TimeInterval) -> String?

        static let live = DiscoveryContext(
            tailscaleStatus: { readTailscaleStatus() },
            dig: { args, timeout in
                runDig(args: args, timeout: timeout)
            })
    }

    static func discover(
        timeoutSeconds: TimeInterval = 2.0,
        context: DiscoveryContext = .live) -> [WideAreaGatewayBeacon]
    {
        let startedAt = Date()
        let remaining = {
            timeoutSeconds - Date().timeIntervalSince(startedAt)
        }

        guard let ips = collectTailnetIPv4s(
            statusJson: context.tailscaleStatus()).nonEmpty else { return [] }
        var candidates = Array(ips.prefix(self.maxCandidates))
        guard let nameserver = findNameserver(
            candidates: &candidates,
            remaining: remaining,
            dig: context.dig)
        else {
            return []
        }

        let domain = MoltbotBonjour.wideAreaGatewayServiceDomain
        let domainTrimmed = domain.trimmingCharacters(in: CharacterSet(charactersIn: "."))
        let probeName = "_moltbot-gw._tcp.\(domainTrimmed)"
        guard let ptrLines = context.dig(
            ["+short", "+time=1", "+tries=1", "@\(nameserver)", probeName, "PTR"],
            min(defaultTimeoutSeconds, remaining()))?.split(whereSeparator: \.isNewline),
            !ptrLines.isEmpty
        else {
            return []
        }

        var beacons: [WideAreaGatewayBeacon] = []
        for raw in ptrLines {
            let ptr = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if ptr.isEmpty { continue }
            let ptrName = ptr.hasSuffix(".") ? String(ptr.dropLast()) : ptr
            let suffix = "._moltbot-gw._tcp.\(domainTrimmed)"
            let rawInstanceName = ptrName.hasSuffix(suffix)
                ? String(ptrName.dropLast(suffix.count))
                : ptrName
            let instanceName = self.decodeDnsSdEscapes(rawInstanceName)

            guard let srv = context.dig(
                ["+short", "+time=1", "+tries=1", "@\(nameserver)", ptrName, "SRV"],
                min(defaultTimeoutSeconds, remaining()))
            else { continue }
            guard let (host, port) = parseSrv(srv) else { continue }

            let txtRaw = context.dig(
                ["+short", "+time=1", "+tries=1", "@\(nameserver)", ptrName, "TXT"],
                min(self.defaultTimeoutSeconds, remaining()))
            let txtTokens = txtRaw.map(self.parseTxtTokens) ?? []
            let txt = self.mapTxt(tokens: txtTokens)

            let displayName = txt["displayName"] ?? instanceName
            let beacon = WideAreaGatewayBeacon(
                instanceName: instanceName,
                displayName: displayName,
                host: host,
                port: port,
                lanHost: txt["lanHost"],
                tailnetDns: txt["tailnetDns"],
                gatewayPort: parseInt(txt["gatewayPort"]),
                sshPort: parseInt(txt["sshPort"]),
                cliPath: txt["cliPath"])
            beacons.append(beacon)
        }

        return beacons
    }

    private static func collectTailnetIPv4s(statusJson: String?) -> [String] {
        guard let statusJson else { return [] }
        let decoder = JSONDecoder()
        guard let data = statusJson.data(using: .utf8),
              let status = try? decoder.decode(TailscaleStatus.self, from: data)
        else { return [] }

        var ips: [String] = []
        ips.append(contentsOf: status.selfNode?.resolvedIPs ?? [])
        if let peers = status.peer {
            for peer in peers.values {
                ips.append(contentsOf: peer.resolvedIPs)
            }
        }

        var seen = Set<String>()
        let ordered = ips.filter { value in
            guard self.isTailnetIPv4(value) else { return false }
            if seen.contains(value) { return false }
            seen.insert(value)
            return true
        }
        return ordered
    }

    private static func readTailscaleStatus() -> String? {
        let candidates = [
            "/usr/local/bin/tailscale",
            "/opt/homebrew/bin/tailscale",
            "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
            "tailscale",
        ]

        var output: String?
        for candidate in candidates {
            if let result = run(
                path: candidate,
                args: ["status", "--json"],
                timeout: 0.7)
            {
                output = result
                break
            }
        }

        return output
    }

    private static func findNameserver(
        candidates: inout [String],
        remaining: () -> TimeInterval,
        dig: @escaping @Sendable (_ args: [String], _ timeout: TimeInterval) -> String?) -> String?
    {
        let domain = MoltbotBonjour.wideAreaGatewayServiceDomain
        let domainTrimmed = domain.trimmingCharacters(in: CharacterSet(charactersIn: "."))
        let probeName = "_moltbot-gw._tcp.\(domainTrimmed)"

        let ips = candidates
        candidates.removeAll(keepingCapacity: true)
        if ips.isEmpty { return nil }

        final class ProbeState: @unchecked Sendable {
            let lock = NSLock()
            var nextIndex = 0
            var found: String?
        }

        let state = ProbeState()
        let deadline = Date().addingTimeInterval(max(0, remaining()))
        let workerCount = min(self.nameserverProbeConcurrency, ips.count)
        let group = DispatchGroup()

        for _ in 0..<workerCount {
            group.enter()
            DispatchQueue.global(qos: .utility).async {
                defer { group.leave() }

                while Date() < deadline {
                    state.lock.lock()
                    if state.found != nil {
                        state.lock.unlock()
                        return
                    }
                    let i = state.nextIndex
                    state.nextIndex += 1
                    state.lock.unlock()

                    if i >= ips.count { return }
                    let ip = ips[i]
                    let budget = deadline.timeIntervalSinceNow
                    if budget <= 0 { return }

                    if let stdout = dig(
                        ["+short", "+time=1", "+tries=1", "@\(ip)", probeName, "PTR"],
                        min(defaultTimeoutSeconds, budget)),
                        stdout.split(whereSeparator: \.isNewline).isEmpty == false
                    {
                        state.lock.lock()
                        if state.found == nil {
                            state.found = ip
                        }
                        state.lock.unlock()
                        return
                    }
                }
            }
        }

        _ = group.wait(timeout: .now() + max(0.0, remaining()))
        return state.found
    }

    private static func runDig(args: [String], timeout: TimeInterval) -> String? {
        self.run(path: self.digPath, args: args, timeout: timeout)
    }

    private static func run(path: String, args: [String], timeout: TimeInterval) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = args
        let outPipe = Pipe()
        let errPipe = Pipe()
        process.standardOutput = outPipe
        process.standardError = errPipe

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

    private static func parseSrv(_ stdout: String) -> (String, Int)? {
        let line = stdout
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first(where: { !$0.isEmpty })
        guard let line else { return nil }
        let parts = line.split(whereSeparator: { $0 == " " || $0 == "\t" }).map(String.init)
        guard parts.count >= 4 else { return nil }
        guard let port = Int(parts[2]), port > 0 else { return nil }
        let host = parts[3].hasSuffix(".") ? String(parts[3].dropLast()) : parts[3]
        return (host, port)
    }

    private static func parseTxtTokens(_ stdout: String) -> [String] {
        let lines = stdout.split(whereSeparator: \.isNewline)
        var tokens: [String] = []
        for raw in lines {
            let line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.isEmpty { continue }
            let matches = line.matches(of: /"([^"]*)"/)
            for match in matches {
                tokens.append(self.unescapeTxt(String(match.1)))
            }
        }
        return tokens
    }

    private static func unescapeTxt(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\\\\", with: "\\")
            .replacingOccurrences(of: "\\\"", with: "\"")
            .replacingOccurrences(of: "\\n", with: "\n")
    }

    private static func mapTxt(tokens: [String]) -> [String: String] {
        var out: [String: String] = [:]
        for token in tokens {
            guard let idx = token.firstIndex(of: "=") else { continue }
            let key = String(token[..<idx]).trimmingCharacters(in: .whitespacesAndNewlines)
            let rawValue = String(token[token.index(after: idx)...])
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let value = self.decodeDnsSdEscapes(rawValue)
            if !key.isEmpty { out[key] = value }
        }
        return out
    }

    private static func parseInt(_ value: String?) -> Int? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return Int(trimmed)
    }

    private static func isTailnetIPv4(_ value: String) -> Bool {
        let parts = value.split(separator: ".")
        if parts.count != 4 { return false }
        let octets = parts.compactMap { Int($0) }
        if octets.count != 4 { return false }
        let a = octets[0]
        let b = octets[1]
        return a == 100 && b >= 64 && b <= 127
    }

    private static func decodeDnsSdEscapes(_ value: String) -> String {
        var bytes: [UInt8] = []
        var pending = ""

        func flushPending() {
            guard !pending.isEmpty else { return }
            bytes.append(contentsOf: pending.utf8)
            pending = ""
        }

        let chars = Array(value)
        var i = 0
        while i < chars.count {
            let ch = chars[i]
            if ch == "\\", i + 3 < chars.count {
                let digits = String(chars[(i + 1)...(i + 3)])
                if digits.allSatisfy(\.isNumber),
                   let byte = UInt8(digits)
                {
                    flushPending()
                    bytes.append(byte)
                    i += 4
                    continue
                }
            }
            pending.append(ch)
            i += 1
        }
        flushPending()

        if bytes.isEmpty { return value }
        if let decoded = String(bytes: bytes, encoding: .utf8) {
            return decoded
        }
        return value
    }
}

private struct TailscaleStatus: Decodable {
    struct Node: Decodable {
        let tailscaleIPs: [String]?

        var resolvedIPs: [String] {
            self.tailscaleIPs ?? []
        }

        private enum CodingKeys: String, CodingKey {
            case tailscaleIPs = "TailscaleIPs"
        }
    }

    let selfNode: Node?
    let peer: [String: Node]?

    private enum CodingKeys: String, CodingKey {
        case selfNode = "Self"
        case peer = "Peer"
    }
}

extension Collection {
    fileprivate var nonEmpty: Self? { isEmpty ? nil : self }
}
