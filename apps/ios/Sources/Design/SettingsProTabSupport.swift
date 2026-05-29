import Darwin
import SwiftUI

enum SettingsRoute: Hashable {
    case gateway
    case permissions
    case voice
    case diagnostics
    case privacy
    case notifications
    case about
}

enum SettingsLayout {
    static let cardRadius: CGFloat = 12
    static let rowHeight: CGFloat = 58
}

enum SettingsDiagnosticIssue: String, Equatable, CaseIterable {
    case gatewayOffline
    case discoveryUnavailable
    case talkConfigMissing
    case notificationsUnavailable
}

enum SettingsDiagnostics {
    static func issues(
        gatewayConnected: Bool,
        discoveredGatewayCount: Int,
        talkConfigLoaded: Bool,
        notificationStatusText: String) -> [SettingsDiagnosticIssue]
    {
        var issues: [SettingsDiagnosticIssue] = []
        if !gatewayConnected { issues.append(.gatewayOffline) }
        if discoveredGatewayCount == 0 { issues.append(.discoveryUnavailable) }
        if gatewayConnected, !talkConfigLoaded { issues.append(.talkConfigMissing) }
        if notificationStatusText != "Allowed" { issues.append(.notificationsUnavailable) }
        return issues
    }

    static func issueCount(
        gatewayConnected: Bool,
        discoveredGatewayCount: Int,
        talkConfigLoaded: Bool,
        notificationStatusText: String) -> Int
    {
        self.issues(
            gatewayConnected: gatewayConnected,
            discoveredGatewayCount: discoveredGatewayCount,
            talkConfigLoaded: talkConfigLoaded,
            notificationStatusText: notificationStatusText).count
    }

    static func timestamp(_ date: Date) -> String {
        date.formatted(date: .omitted, time: .shortened)
    }
}

extension SettingsProTab {
    static func hasTailnetIPv4() -> Bool {
        var addrList: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&addrList) == 0, let first = addrList else { return false }
        defer { freeifaddrs(addrList) }
        for ptr in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let flags = Int32(ptr.pointee.ifa_flags)
            let isUp = (flags & IFF_UP) != 0
            let isLoopback = (flags & IFF_LOOPBACK) != 0
            guard let addrPtr = ptr.pointee.ifa_addr else { continue }
            let family = addrPtr.pointee.sa_family
            if !isUp || isLoopback || family != UInt8(AF_INET) { continue }
            var addr = addrPtr.pointee
            var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            let result = getnameinfo(
                &addr,
                socklen_t(addrPtr.pointee.sa_len),
                &buffer,
                socklen_t(buffer.count),
                nil,
                0,
                NI_NUMERICHOST)
            guard result == 0 else { continue }
            let bytes = buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }
            guard let ip = String(bytes: bytes, encoding: .utf8) else { continue }
            if self.isTailnetIPv4(ip) { return true }
        }
        return false
    }

    static func isTailnetHostOrIP(_ host: String) -> Bool {
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if trimmed.hasSuffix(".ts.net") || trimmed.hasSuffix(".ts.net.") { return true }
        return self.isTailnetIPv4(trimmed)
    }

    static func isTailnetIPv4(_ ip: String) -> Bool {
        let parts = ip.split(separator: ".")
        guard parts.count == 4 else { return false }
        let octets = parts.compactMap { Int($0) }
        guard octets.count == 4 else { return false }
        let a = octets[0]
        let b = octets[1]
        guard (0...255).contains(a), (0...255).contains(b) else { return false }
        return a == 100 && b >= 64 && b <= 127
    }
}
