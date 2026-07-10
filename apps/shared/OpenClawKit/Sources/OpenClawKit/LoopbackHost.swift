import Foundation
import Network

public enum LoopbackHost {
    public static func isLoopback(_ rawHost: String) -> Bool {
        self.isLoopbackHost(rawHost)
    }

    public static func isLoopbackHost(_ rawHost: String) -> Bool {
        var host = rawHost
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if host.hasSuffix(".") {
            host.removeLast()
        }
        if let zoneIndex = host.firstIndex(of: "%") {
            host = String(host[..<zoneIndex])
        }
        if host.isEmpty {
            return false
        }
        if host == "localhost" || host == "0.0.0.0" || host == "::" {
            return true
        }

        if let ipv4 = IPv4Address(host) {
            return ipv4.rawValue.first == 127
        }
        if let ipv6 = IPv6Address(host) {
            let bytes = Array(ipv6.rawValue)
            let isV6Loopback = bytes[0..<15].allSatisfy { $0 == 0 } && bytes[15] == 1
            if isV6Loopback {
                return true
            }
            let isMappedV4 = bytes[0..<10].allSatisfy { $0 == 0 } && bytes[10] == 0xFF && bytes[11] == 0xFF
            return isMappedV4 && bytes[12] == 127
        }

        return false
    }

    public static func isLocalNetworkHost(_ rawHost: String) -> Bool {
        let host = self.normalizedHost(rawHost)
        guard !host.isEmpty else { return false }
        if self.isLoopbackHost(host) { return true }
        if host.hasSuffix(".local") { return true }
        if let ipv4 = self.parseIPv4(host) {
            return self.isLocalNetworkIPv4(ipv4)
        }
        guard let ipv6 = IPv6Address(host) else { return false }
        let bytes = Array(ipv6.rawValue)
        let isUniqueLocal = (bytes[0] & 0xFE) == 0xFC
        let isLinkLocal = bytes[0] == 0xFE && (bytes[1] & 0xC0) == 0x80
        return isUniqueLocal || isLinkLocal
    }

    static func normalizedHost(_ rawHost: String) -> String {
        var host = rawHost
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if host.hasSuffix(".") {
            host.removeLast()
        }
        if let zoneIndex = host.firstIndex(of: "%") {
            host = String(host[..<zoneIndex])
        }
        return host
    }

    static func parseIPv4(_ host: String) -> (UInt8, UInt8, UInt8, UInt8)? {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        let bytes: [UInt8] = parts.compactMap { UInt8($0) }
        guard bytes.count == 4 else { return nil }
        return (bytes[0], bytes[1], bytes[2], bytes[3])
    }

    static func isLocalNetworkIPv4(_ ip: (UInt8, UInt8, UInt8, UInt8)) -> Bool {
        let (a, b, _, _) = ip
        // 10.0.0.0/8
        if a == 10 { return true }
        // 172.16.0.0/12
        if a == 172, (16...31).contains(Int(b)) { return true }
        // 192.168.0.0/16
        if a == 192, b == 168 { return true }
        // 127.0.0.0/8
        if a == 127 { return true }
        // 169.254.0.0/16 (link-local)
        if a == 169, b == 254 { return true }
        return false
    }
}
