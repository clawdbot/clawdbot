import AppKit
import SwiftUI

struct NodeMenuEntryFormatter {
    static func isGateway(_ entry: NodeInfo) -> Bool {
        entry.nodeId == "gateway"
    }

    static func isConnected(_ entry: NodeInfo) -> Bool {
        entry.isConnected
    }

    static func primaryName(_ entry: NodeInfo) -> String {
        if self.isGateway(entry) {
            return entry.displayName?.nonEmpty ?? "Gateway"
        }
        return entry.displayName?.nonEmpty ?? entry.nodeId
    }

    static func summaryText(_ entry: NodeInfo) -> String {
        if self.isGateway(entry) {
            let role = self.roleText(entry)
            let name = self.primaryName(entry)
            var parts = ["\(name) · \(role)"]
            if let ip = entry.remoteIp?.nonEmpty { parts.append("host \(ip)") }
            if let platform = self.platformText(entry) { parts.append(platform) }
            return parts.joined(separator: " · ")
        }
        let name = self.primaryName(entry)
        var prefix = "Node: \(name)"
        if let ip = entry.remoteIp?.nonEmpty {
            prefix += " (\(ip))"
        }
        var parts = [prefix]
        if let platform = self.platformText(entry) {
            parts.append("platform \(platform)")
        }
        let versionLabels = self.versionLabels(entry)
        if !versionLabels.isEmpty {
            parts.append(versionLabels.joined(separator: " · "))
        }
        parts.append("status \(self.roleText(entry))")
        return parts.joined(separator: " · ")
    }

    static func roleText(_ entry: NodeInfo) -> String {
        if entry.isConnected { return "connected" }
        if self.isGateway(entry) { return "disconnected" }
        if entry.isPaired { return "paired" }
        return "unpaired"
    }

    static func detailLeft(_ entry: NodeInfo) -> String {
        let role = self.roleText(entry)
        if let ip = entry.remoteIp?.nonEmpty { return "\(ip) · \(role)" }
        return role
    }

    static func headlineRight(_ entry: NodeInfo) -> String? {
        self.platformText(entry)
    }

    static func detailRightVersion(_ entry: NodeInfo) -> String? {
        let labels = self.versionLabels(entry, compact: false)
        if labels.isEmpty { return nil }
        return labels.joined(separator: " · ")
    }

    static func platformText(_ entry: NodeInfo) -> String? {
        if let raw = entry.platform?.nonEmpty {
            return self.prettyPlatform(raw) ?? raw
        }
        if let family = entry.deviceFamily?.lowercased() {
            if family.contains("mac") { return "macOS" }
            if family.contains("iphone") { return "iOS" }
            if family.contains("ipad") { return "iPadOS" }
            if family.contains("android") { return "Android" }
        }
        return nil
    }

    private static func prettyPlatform(_ raw: String) -> String? {
        let (prefix, version) = self.parsePlatform(raw)
        if prefix.isEmpty { return nil }
        let name: String = switch prefix {
        case "macos": "macOS"
        case "ios": "iOS"
        case "ipados": "iPadOS"
        case "tvos": "tvOS"
        case "watchos": "watchOS"
        default: prefix.prefix(1).uppercased() + prefix.dropFirst()
        }
        guard let version, !version.isEmpty else { return name }
        let parts = version.split(separator: ".").map(String.init)
        if parts.count >= 2 {
            return "\(name) \(parts[0]).\(parts[1])"
        }
        return "\(name) \(version)"
    }

    private static func parsePlatform(_ raw: String) -> (prefix: String, version: String?) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return ("", nil) }
        let parts = trimmed.split(whereSeparator: { $0 == " " || $0 == "\t" }).map(String.init)
        let prefix = parts.first?.lowercased() ?? ""
        let versionToken = parts.dropFirst().first
        return (prefix, versionToken)
    }

    private static func compactVersion(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return trimmed }
        if let range = trimmed.range(
            of: #"\s*\([^)]*\d[^)]*\)$"#,
            options: .regularExpression)
        {
            return String(trimmed[..<range.lowerBound])
        }
        return trimmed
    }

    private static func shortVersionLabel(_ raw: String) -> String {
        let compact = self.compactVersion(raw)
        if compact.isEmpty { return compact }
        if compact.lowercased().hasPrefix("v") { return compact }
        if let first = compact.unicodeScalars.first, CharacterSet.decimalDigits.contains(first) {
            return "v\(compact)"
        }
        return compact
    }

    private static func versionLabels(_ entry: NodeInfo, compact: Bool = true) -> [String] {
        let (core, ui) = self.resolveVersions(entry)
        var labels: [String] = []
        if let core {
            let label = compact ? self.compactVersion(core) : self.shortVersionLabel(core)
            labels.append("core \(label)")
        }
        if let ui {
            let label = compact ? self.compactVersion(ui) : self.shortVersionLabel(ui)
            labels.append("ui \(label)")
        }
        return labels
    }

    private static func resolveVersions(_ entry: NodeInfo) -> (core: String?, ui: String?) {
        let core = entry.coreVersion?.nonEmpty
        let ui = entry.uiVersion?.nonEmpty
        if core != nil || ui != nil {
            return (core, ui)
        }
        guard let legacy = entry.version?.nonEmpty else { return (nil, nil) }
        if self.isHeadlessPlatform(entry) {
            return (legacy, nil)
        }
        return (nil, legacy)
    }

    private static func isHeadlessPlatform(_ entry: NodeInfo) -> Bool {
        let raw = entry.platform?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        if raw == "darwin" || raw == "linux" || raw == "win32" || raw == "windows" { return true }
        return false
    }

    static func leadingSymbol(_ entry: NodeInfo) -> String {
        if self.isGateway(entry) {
            return self.safeSystemSymbol(
                "antenna.radiowaves.left.and.right",
                fallback: "dot.radiowaves.left.and.right")
        }
        if let family = entry.deviceFamily?.lowercased() {
            if family.contains("mac") {
                return self.safeSystemSymbol("laptopcomputer", fallback: "laptopcomputer")
            }
            if family.contains("iphone") { return self.safeSystemSymbol("iphone", fallback: "iphone") }
            if family.contains("ipad") { return self.safeSystemSymbol("ipad", fallback: "ipad") }
        }
        if let platform = entry.platform?.lowercased() {
            if platform.contains("mac") { return self.safeSystemSymbol("laptopcomputer", fallback: "laptopcomputer") }
            if platform.contains("ios") { return self.safeSystemSymbol("iphone", fallback: "iphone") }
            if platform.contains("android") { return self.safeSystemSymbol("cpu", fallback: "cpu") }
        }
        return "cpu"
    }

    static func isAndroid(_ entry: NodeInfo) -> Bool {
        let family = entry.deviceFamily?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if family == "android" { return true }
        let platform = entry.platform?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return platform?.contains("android") == true
    }

    private static func safeSystemSymbol(_ preferred: String, fallback: String) -> String {
        if NSImage(systemSymbolName: preferred, accessibilityDescription: nil) != nil { return preferred }
        return fallback
    }
}

struct NodeMenuRowView: View {
    let entry: NodeInfo
    let width: CGFloat
    @Environment(\.menuItemHighlighted) private var isHighlighted

    private var primaryColor: Color {
        self.isHighlighted ? Color(nsColor: .selectedMenuItemTextColor) : .primary
    }

    private var secondaryColor: Color {
        self.isHighlighted ? Color(nsColor: .selectedMenuItemTextColor).opacity(0.85) : .secondary
    }

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            self.leadingIcon
                .frame(width: 22, height: 22, alignment: .center)

            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(NodeMenuEntryFormatter.primaryName(self.entry))
                        .font(.callout.weight(NodeMenuEntryFormatter.isConnected(self.entry) ? .semibold : .regular))
                        .foregroundStyle(self.primaryColor)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .layoutPriority(1)

                    Spacer(minLength: 8)

                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        if let right = NodeMenuEntryFormatter.headlineRight(self.entry) {
                            Text(right)
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(self.secondaryColor)
                                .lineLimit(1)
                                .truncationMode(.middle)
                                .layoutPriority(2)
                        }

                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(self.secondaryColor)
                            .padding(.leading, 2)
                    }
                }

                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(NodeMenuEntryFormatter.detailLeft(self.entry))
                        .font(.caption)
                        .foregroundStyle(self.secondaryColor)
                        .lineLimit(1)
                        .truncationMode(.middle)

                    Spacer(minLength: 0)

                    if let version = NodeMenuEntryFormatter.detailRightVersion(self.entry) {
                        Text(version)
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(self.secondaryColor)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 8)
        .padding(.leading, 18)
        .padding(.trailing, 12)
        .frame(width: max(1, self.width), alignment: .leading)
    }

    @ViewBuilder
    private var leadingIcon: some View {
        if NodeMenuEntryFormatter.isAndroid(self.entry) {
            AndroidMark()
                .foregroundStyle(self.secondaryColor)
        } else {
            Image(systemName: NodeMenuEntryFormatter.leadingSymbol(self.entry))
                .font(.system(size: 18, weight: .regular))
                .foregroundStyle(self.secondaryColor)
        }
    }
}

struct AndroidMark: View {
    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let h = geo.size.height
            let headHeight = h * 0.68
            let headWidth = w * 0.92
            let headX = (w - headWidth) * 0.5
            let headY = (h - headHeight) * 0.5
            let corner = min(w, h) * 0.18
            RoundedRectangle(cornerRadius: corner, style: .continuous)
                .frame(width: headWidth, height: headHeight)
                .position(x: headX + headWidth * 0.5, y: headY + headHeight * 0.5)
        }
    }
}

struct NodeMenuMultilineView: View {
    let label: String
    let value: String
    let width: CGFloat
    @Environment(\.menuItemHighlighted) private var isHighlighted

    private var primaryColor: Color {
        self.isHighlighted ? Color(nsColor: .selectedMenuItemTextColor) : .primary
    }

    private var secondaryColor: Color {
        self.isHighlighted ? Color(nsColor: .selectedMenuItemTextColor).opacity(0.85) : .secondary
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("\(self.label):")
                .font(.caption.weight(.semibold))
                .foregroundStyle(self.secondaryColor)

            Text(self.value)
                .font(.caption)
                .foregroundStyle(self.primaryColor)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 6)
        .padding(.leading, 18)
        .padding(.trailing, 12)
        .frame(width: max(1, self.width), alignment: .leading)
    }
}
