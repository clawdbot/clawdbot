import Foundation
import SwiftUI

struct GatewayMenuCardModel: Equatable, Sendable {
    let name: String
    let isPrimary: Bool
    let isFrontmost: Bool
    let shortcutNumber: Int?
    let health: DashboardGatewayHealth
    let version: String?
    let buildId: String?
    let endpointLabel: String?
    let transportLabel: String?
    let latencyMs: Double?
    let windowCount: Int
    let browserSessionExpiresAt: Date?
    let lastSeen: Date?
    let isProbing: Bool

    func secondaryLine(now _: Date) -> String {
        [self.version, self.buildId.flatMap(Self.shortBuild), self.endpointLabel, self.transportLabel]
            .compactMap { $0?.nonEmpty }
            .joined(separator: " · ")
    }

    /// Gateway build ids look like `2026.9.1-release-303796cd7872-2026-09-05T21-06-03.000Z`;
    /// show the commit segment, or the whole id shortened when no commit is embedded.
    static func shortBuild(_ buildId: String) -> String? {
        let trimmed = buildId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        for segment in trimmed.split(separator: "-") where segment.count >= 7 {
            if segment.allSatisfy(\.isHexDigit), segment.contains(where: \.isLetter) || segment.count >= 12 {
                return String(segment.prefix(7))
            }
        }
        return String(trimmed.prefix(7))
    }

    func tertiaryLine(now: Date) -> String {
        if self.isProbing, self.health != .error,
           self.version == nil, self.buildId == nil, self.latencyMs == nil, self.lastSeen == nil
        {
            return String(localized: "checking…")
        }

        var parts: [String] = []
        if self.health == .error {
            parts.append(String(localized: "unreachable"))
            if let lastSeen = self.lastSeen {
                let seconds = max(0, now.timeIntervalSince(lastSeen))
                parts.append(seconds < 60
                    ? String(localized: "last seen just now")
                    : String(format: String(localized: "last seen %@ ago"), Self.relativeDuration(seconds)))
            }
        } else if let latencyMs = self.latencyMs {
            parts.append(String(format: String(localized: "%.0f ms"), latencyMs))
        }
        parts.append(self.windowCount == 1
            ? String(localized: "1 window")
            : String(format: String(localized: "%lld windows"), self.windowCount))
        if let expiresAt = self.browserSessionExpiresAt {
            let seconds = expiresAt.timeIntervalSince(now)
            parts.append(seconds <= 0
                ? String(localized: "session expired")
                : String(format: String(localized: "session expires in %@"), Self.relativeDuration(seconds)))
        }
        return parts.joined(separator: " · ")
    }

    private static func relativeDuration(_ seconds: TimeInterval) -> String {
        if seconds < 60 { return String(localized: "<1 min") }
        if seconds < 3600 { return String(format: String(localized: "%lld min"), Int(seconds / 60)) }
        if seconds < 86400 { return String(format: String(localized: "%lldh"), Int(seconds / 3600)) }
        return String(format: String(localized: "%lldd"), Int(seconds / 86400))
    }
}

@MainActor
struct GatewayMenuCard: View {
    let model: GatewayMenuCardModel
    var now = Date()
    @Environment(\.menuItemHighlighted) private var isHighlighted

    private var palette: MenuItemHighlightColors.Palette {
        MenuItemHighlightColors.palette(self.isHighlighted)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                self.healthIndicator

                Text(self.model.name)
                    .font(.callout.weight(self.model.isPrimary ? .semibold : .regular))
                    .foregroundStyle(self.palette.primary)
                    .lineLimit(1)
                    .truncationMode(.middle)

                if self.model.isPrimary {
                    Text(String(localized: "Primary"))
                        .font(.caption2)
                        .foregroundStyle(self.palette.secondary)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(self.palette.secondary.opacity(0.12), in: Capsule())
                }

                Spacer(minLength: 4)

                if let shortcut = self.model.shortcutNumber {
                    Text(verbatim: "⌘" + String(shortcut))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(self.palette.secondary)
                }
            }

            Text(self.model.secondaryLine(now: self.now))
                .font(.caption)
                .foregroundStyle(self.palette.secondary)
                .lineLimit(1, reservesSpace: true)
                .truncationMode(.middle)

            Text(self.model.tertiaryLine(now: self.now))
                .font(.caption)
                .foregroundStyle(self.palette.secondary)
                .lineLimit(1, reservesSpace: true)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .frame(width: StatusMenuMetrics.width, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(self.accessibilityLabel)
    }

    private var healthIndicator: some View {
        Group {
            if let image = StatusMenuSummaries.gatewayImage(health: self.model.health, name: self.model.name) {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(width: 10, height: 10)
            }
        }
        .frame(width: 16, height: 16)
        .overlay {
            if self.model.isFrontmost {
                Circle().strokeBorder(self.palette.secondary.opacity(0.6), lineWidth: 1)
            }
        }
    }

    private var accessibilityLabel: String {
        let health = switch self.model.health {
        case .ok: String(localized: "healthy")
        case .error: String(localized: "health error")
        case .unknown: String(localized: "health unknown")
        }
        var parts = [self.model.name, health]
        if self.model.isPrimary { parts.append(String(localized: "Primary")) }
        if self.model.isFrontmost { parts.append(String(localized: "frontmost Gateway")) }
        parts.append(self.model.secondaryLine(now: self.now))
        parts.append(self.model.tertiaryLine(now: self.now))
        return parts.filter { !$0.isEmpty }.joined(separator: ", ")
    }
}
