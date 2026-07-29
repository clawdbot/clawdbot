import Foundation
import OpenClawKit

struct WideAreaGatewayBeacon: Equatable {
    var instanceName: String
    var displayName: String
    var host: String
    var port: Int
    var lanHost: String?
    var tailnetDns: String?
    var gatewayPort: Int?
    var gatewayTls: Bool
    var gatewayDirectReachable: Bool
    var sshPort: Int?
    var cliPath: String?
}

enum WideAreaGatewayDiscovery {
    private static let digPath = "/usr/bin/dig"
    private static let defaultTimeoutSeconds: TimeInterval = 0.2
    // Security: wide-area discovery must trust only the Tailscale MagicDNS resolver.
    // Probing arbitrary tailnet peers lets the fastest responder become DNS-SD authority.
    private static let tailscaleDNSResolver = "100.100.100.100"

    struct DiscoveryContext {
        var tailscaleStatus: @Sendable () async -> String?
        var dig: @Sendable (_ args: [String], _ timeout: TimeInterval) async -> String?

        static let live = DiscoveryContext(
            tailscaleStatus: { await readTailscaleStatus() },
            dig: { args, timeout in
                await runDig(args: args, timeout: timeout)
            })
    }

    static func discover(
        timeoutSeconds: TimeInterval = 2.0,
        context: DiscoveryContext = .live) async -> [WideAreaGatewayBeacon]
    {
        let startedAt = Date()
        let remaining = {
            timeoutSeconds - Date().timeIntervalSince(startedAt)
        }

        guard let statusJson = await context.tailscaleStatus(),
              !collectTailnetIPv4s(statusJson: statusJson).isEmpty,
              let discovery = await loadWideAreaPtrRecords(
                  remaining: remaining,
                  dig: context.dig)
        else { return [] }

        let domainTrimmed = discovery.domainTrimmed
        let ptrLines = discovery.ptrLines
        let nameserver = self.tailscaleDNSResolver

        var beacons: [WideAreaGatewayBeacon] = []
        for raw in ptrLines {
            let ptr = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if ptr.isEmpty { continue }
            let ptrName = ptr.hasSuffix(".") ? String(ptr.dropLast()) : ptr
            let suffix = "._openclaw-gw._tcp.\(domainTrimmed)"
            let rawInstanceName = ptrName.hasSuffix(suffix)
                ? String(ptrName.dropLast(suffix.count))
                : ptrName
            let instanceName = self.decodeDnsSdEscapes(rawInstanceName)

            guard let srv = await context.dig(
                ["+short", "+time=1", "+tries=1", "@\(nameserver)", ptrName, "SRV"],
                min(defaultTimeoutSeconds, remaining()))
            else { continue }
            guard let (host, port) = parseSrv(srv) else { continue }

            let txtRaw = await context.dig(
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
                gatewayTls: parseBool(txt["gatewayTls"]),
                gatewayDirectReachable: parseBool(txt["gatewayDirectReachable"]),
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
        return ips.filter { value in
            guard self.isTailnetIPv4(value) else { return false }
            if seen.contains(value) { return false }
            seen.insert(value)
            return true
        }
    }

    private static func readTailscaleStatus() async -> String? {
        let candidates = [
            "/usr/local/bin/tailscale",
            "/opt/homebrew/bin/tailscale",
            "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
            "tailscale",
        ]

        var output: String?
        for candidate in candidates {
            if let result = await BoundedCommand.run(
                path: candidate,
                arguments: ["status", "--json"],
                timeout: 0.7)
            {
                output = result
                break
            }
        }

        return output
    }

    private static func loadWideAreaPtrRecords(
        remaining: () -> TimeInterval,
        dig: @escaping @Sendable (_ args: [String], _ timeout: TimeInterval) async -> String?)
        async -> (domainTrimmed: String, ptrLines: [Substring])?
    {
        guard let domain = OpenClawBonjour.wideAreaGatewayServiceDomain else { return nil }
        let domainTrimmed = domain.trimmingCharacters(in: CharacterSet(charactersIn: "."))
        let probeName = "_openclaw-gw._tcp.\(domainTrimmed)"
        let budget = max(0, remaining())
        if budget <= 0 { return nil }

        guard let stdout = await dig(
            ["+short", "+time=1", "+tries=1", "@\(self.tailscaleDNSResolver)", probeName, "PTR"],
            min(defaultTimeoutSeconds, budget)),
            let ptrLines = stdout.split(whereSeparator: \.isNewline).nonEmpty
        else {
            return nil
        }

        return (domainTrimmed, ptrLines)
    }

    private static func runDig(args: [String], timeout: TimeInterval) async -> String? {
        await BoundedCommand.run(path: self.digPath, arguments: args, timeout: timeout)
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

    private static func parseBool(_ value: String?) -> Bool {
        guard let value else { return false }
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return normalized == "1" || normalized == "true" || normalized == "yes"
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
    fileprivate var nonEmpty: Self? {
        isEmpty ? nil : self
    }
}
