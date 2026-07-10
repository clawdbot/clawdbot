import Foundation
import SwiftUI

/// Snapshot of how full the active session's context window is, derived from
/// the newest usage-bearing message plus session/model metadata.
public struct OpenClawChatContextUsage: Equatable, Sendable {
    public let usedTokens: Int
    public let contextWindowTokens: Int?
    public let totalCost: Double?

    public var fractionUsed: Double? {
        guard let contextWindowTokens, contextWindowTokens > 0 else { return nil }
        return min(1, max(0, Double(self.usedTokens) / Double(contextWindowTokens)))
    }

    public var percentUsed: Int? {
        self.fractionUsed.map { Int(($0 * 100).rounded()) }
    }
}

enum ChatContextUsageCalculator {
    /// Prefers the newest per-run usage (fresh after every reply) and falls
    /// back to fresh server-side session totals when no message carries usage.
    static func usage(
        messages: [OpenClawChatMessage],
        sessionEntry: OpenClawChatSessionEntry?,
        defaults: OpenClawChatSessionsDefaults?,
        modelContextWindow: Int?) -> OpenClawChatContextUsage?
    {
        let sessionTokens = sessionEntry?.totalTokensFresh == false ? nil : sessionEntry?.totalTokens
        let usedTokens = self.latestRunTokens(in: messages) ?? sessionTokens
        guard let usedTokens, usedTokens > 0 else { return nil }
        let contextWindow = self.positive(sessionEntry?.contextTokens)
            ?? self.positive(defaults?.contextTokens)
            ?? self.positive(modelContextWindow)
        return OpenClawChatContextUsage(
            usedTokens: usedTokens,
            contextWindowTokens: contextWindow,
            totalCost: self.totalCost(in: messages))
    }

    /// Context pressure comes from the latest run: its usage already counts
    /// the whole conversation the model saw, so runs are not summed.
    private static func latestRunTokens(in messages: [OpenClawChatMessage]) -> Int? {
        for message in messages.reversed() {
            guard let usage = message.usage else { continue }
            if let total = usage.total, total > 0 {
                return total
            }
            let summed = [usage.input, usage.cacheRead, usage.cacheWrite, usage.output]
                .compactMap(\.self)
                .reduce(0, +)
            if summed > 0 {
                return summed
            }
        }
        return nil
    }

    private static func totalCost(in messages: [OpenClawChatMessage]) -> Double? {
        let costs = messages.compactMap { $0.usage?.cost?.total }
        guard !costs.isEmpty else { return nil }
        return costs.reduce(0, +)
    }

    private static func positive(_ value: Int?) -> Int? {
        guard let value, value > 0 else { return nil }
        return value
    }
}

extension OpenClawChatViewModel {
    public var contextUsage: OpenClawChatContextUsage? {
        let entry = self.sessions.first { $0.key == self.sessionKey } ??
            self.sessions.first {
                self.matchesCurrentSessionKey(incoming: $0.key, current: self.sessionKey)
            }
        return ChatContextUsageCalculator.usage(
            messages: self.messages,
            sessionEntry: entry,
            defaults: self.sessionDefaults,
            modelContextWindow: self.selectedModelContextWindow(sessionEntry: entry))
    }

    private func selectedModelContextWindow(sessionEntry: OpenClawChatSessionEntry?) -> Int? {
        let selection = self.modelSelectionID != Self.defaultModelSelectionID
            ? self.modelSelectionID
            : (sessionEntry?.model ?? self.sessionDefaults?.model)
        guard let selection else { return nil }
        return self.modelChoices.first {
            $0.selectionID == selection || $0.modelID == selection
        }?.contextWindow
    }
}

struct ChatMessageUsagePresentation: Equatable {
    enum Pressure: Equatable {
        case normal
        case warning
        case danger
    }

    let text: String
    let accessibilityValue: String
    let pressure: Pressure

    static func make(
        message: OpenClawChatMessage,
        contextWindowTokens: Int?) -> ChatMessageUsagePresentation?
    {
        guard message.role.lowercased() == "assistant", let usage = message.usage else { return nil }

        var visualParts: [String] = []
        var accessibilityParts: [String] = []
        let input = self.positive(usage.input)
        let output = self.positive(usage.output)
        let cacheRead = self.positive(usage.cacheRead)
        let cacheWrite = self.positive(usage.cacheWrite)

        if let input {
            visualParts.append("↑\(self.tokens(input))")
            accessibilityParts.append(String(localized: "Input tokens: \(input)"))
        }
        if let output {
            visualParts.append("↓\(self.tokens(output))")
            accessibilityParts.append(String(localized: "Output tokens: \(output)"))
        }
        if let cacheRead {
            visualParts.append("R\(self.tokens(cacheRead))")
            accessibilityParts.append(String(localized: "Cache read tokens: \(cacheRead)"))
        }
        if let cacheWrite {
            visualParts.append("W\(self.tokens(cacheWrite))")
            accessibilityParts.append(String(localized: "Cache write tokens: \(cacheWrite)"))
        }
        if let cost = usage.cost?.total, cost > 0 {
            let formattedCost = String(format: "$%.4f", locale: Locale(identifier: "en_US_POSIX"), cost)
            visualParts.append(formattedCost)
            accessibilityParts.append(String(localized: "Cost: \(formattedCost)"))
        }

        // Context pressure mirrors the Control UI prompt size. Output is response data;
        // input plus cache reads/writes is the context the model received for this run.
        let promptTokens = Double(input ?? 0) + Double(cacheRead ?? 0) + Double(cacheWrite ?? 0)
        let contextPercent: Int?
        if let contextWindowTokens, contextWindowTokens > 0, promptTokens > 0 {
            let roundedPercent = (promptTokens / Double(contextWindowTokens) * 100).rounded()
            contextPercent = Int(min(100, roundedPercent))
        } else {
            contextPercent = nil
        }
        let pressure = self.pressure(for: contextPercent)
        if let contextPercent {
            let warningPrefix = pressure == .normal ? "" : "⚠︎ "
            visualParts.append("\(warningPrefix)\(contextPercent)% \(String(localized: "ctx"))")
            switch pressure {
            case .normal:
                accessibilityParts.append(String(localized: "\(contextPercent) percent of context used"))
            case .warning:
                accessibilityParts.append(String(localized: "Warning: \(contextPercent) percent of context used"))
            case .danger:
                accessibilityParts.append(String(localized: "Critical: \(contextPercent) percent of context used"))
            }
        }

        guard !visualParts.isEmpty else { return nil }
        return ChatMessageUsagePresentation(
            text: visualParts.joined(separator: " "),
            accessibilityValue: accessibilityParts.joined(separator: ", "),
            pressure: pressure)
    }

    private static func pressure(for percent: Int?) -> Pressure {
        guard let percent else { return .normal }
        if percent >= 90 {
            return .danger
        }
        if percent >= 75 {
            return .warning
        }
        return .normal
    }

    private static func positive(_ value: Int?) -> Int? {
        guard let value, value > 0 else { return nil }
        return value
    }

    private static func tokens(_ value: Int) -> String {
        if value >= 1_000_000 {
            return "\(self.trimmedDecimal(Double(value) / 1_000_000))M"
        }
        if value >= 1000 {
            let thousands = Double(value) / 1000
            if thousands >= 999.95 {
                return "\(self.trimmedDecimal(Double(value) / 1_000_000))M"
            }
            return "\(self.trimmedDecimal(thousands))k"
        }
        return "\(value)"
    }

    private static func trimmedDecimal(_ value: Double) -> String {
        String(format: "%.1f", locale: Locale(identifier: "en_US_POSIX"), value)
            .replacingOccurrences(of: ".0", with: "")
    }
}

#if os(macOS)
/// Compact token ring for the window toolbar, mirroring the web UI's context
/// gauge: ring fill and tint track pressure, the menu carries the details.
struct ChatContextUsageIndicator: View {
    let usage: OpenClawChatContextUsage

    var body: some View {
        HStack(spacing: 5) {
            ZStack {
                Circle()
                    .stroke(Color.secondary.opacity(0.25), lineWidth: 2.5)
                Circle()
                    .trim(from: 0, to: max(0.02, self.usage.fractionUsed ?? 0))
                    .stroke(self.tint, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            }
            .frame(width: 13, height: 13)

            if let percent = self.usage.percentUsed {
                Text("\(percent)%")
                    .font(OpenClawChatTypography.captionSemiBold)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Context usage")
        .accessibilityValue(self.accessibilityValue)
    }

    private var tint: Color {
        guard let percent = usage.percentUsed else { return .secondary }
        if percent >= 90 {
            return Color(nsColor: .systemRed)
        }
        if percent >= 75 {
            return Color(nsColor: .systemOrange)
        }
        return Color(nsColor: .systemGreen)
    }

    private var accessibilityValue: String {
        if let percent = self.usage.percentUsed {
            return "\(percent) percent of the context window used"
        }
        return "\(self.usage.usedTokens) tokens used"
    }
}

enum ChatContextUsageFormatter {
    static func tokens(_ value: Int) -> String {
        if value >= 1_000_000 {
            return String(format: "%.1fM", Double(value) / 1_000_000)
        }
        if value >= 1000 {
            return String(format: "%.1fk", Double(value) / 1000)
        }
        return "\(value)"
    }

    static func cost(_ value: Double) -> String {
        String(format: "$%.2f", value)
    }
}
#endif
