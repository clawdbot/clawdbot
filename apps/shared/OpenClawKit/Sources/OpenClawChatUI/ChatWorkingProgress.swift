import Foundation

enum ChatWorkingClawStance: CaseIterable, Equatable, Sendable {
    case standard
    case southpaw
    case flurry
    case spin
    case shadowbox
    case backflip

    private static let weightedStances: [(stance: Self, weight: Double)] = [
        (.standard, 66),
        (.southpaw, 20),
        (.flurry, 5),
        (.spin, 4),
        (.shadowbox, 3),
        (.backflip, 2),
    ]

    static func seeded(_ key: String, salt: UInt32) -> Self {
        let totalWeight = self.weightedStances.reduce(0) { $0 + $1.weight }
        var roll = Double((fnv1a(key) ^ salt) % 1000) / 1000 * totalWeight
        for entry in self.weightedStances {
            roll -= entry.weight
            if roll <= 0 {
                return entry.stance
            }
        }
        return .standard
    }
}

enum ChatWorkingPhrase {
    static let showAfterMilliseconds = 30000
    static let rotateEveryMilliseconds = 45000

    /// Keep source phrases localizable; the post-merge native locale refresh
    /// owns the generated catalog entries.
    static let resources: [String] = [
        String(localized: "Shelling"),
        String(localized: "Scuttling"),
        String(localized: "Clawing"),
        String(localized: "Pinching"),
        String(localized: "Molting"),
        String(localized: "Bubbling"),
        String(localized: "Tiding"),
        String(localized: "Reefing"),
        String(localized: "Cracking"),
        String(localized: "Sifting"),
        String(localized: "Brining"),
        String(localized: "Nautiling"),
        String(localized: "Krilling"),
        String(localized: "Barnacling"),
        String(localized: "Lobstering"),
        String(localized: "Tidepooling"),
        String(localized: "Pearling"),
        String(localized: "Snapping"),
        String(localized: "Surfacing"),
    ]

    /// A constant-time stride walk keeps adjacent phrases distinct. The prime
    /// list length makes every non-zero stride visit all phrases before repeating.
    static func index(seed: String, elapsedMilliseconds: Int) -> Int? {
        guard elapsedMilliseconds >= self.showAfterMilliseconds else { return nil }
        let bucket = (elapsedMilliseconds - self.showAfterMilliseconds) / self.rotateEveryMilliseconds
        return self.index(seed: seed, bucket: bucket)
    }

    static func index(seed: String, bucket: Int) -> Int {
        let count = self.resources.count
        let offset = Int(fnv1a("\(seed):offset") % UInt32(count))
        let stride = 1 + Int(fnv1a("\(seed):stride") % UInt32(count - 1))
        return (offset + bucket * stride) % count
    }
}

enum ChatWorkingDurationFormatter {
    static func compact(milliseconds: Double) -> String {
        let finiteMilliseconds = milliseconds.isFinite ? milliseconds : 1000
        let roundedSeconds = (max(1000, finiteMilliseconds) / 1000).rounded()
        let totalSeconds = max(1, Int(min(roundedSeconds, Double(Int.max / 2))))
        let units = [
            (suffix: "d", seconds: 86400),
            (suffix: "h", seconds: 3600),
            (suffix: "m", seconds: 60),
            (suffix: "s", seconds: 1),
        ]
        var remainder = totalSeconds
        var parts: [String] = []
        for unit in units {
            let value = remainder / unit.seconds
            remainder %= unit.seconds
            if value > 0 {
                parts.append("\(value)\(unit.suffix)")
            }
            if parts.count == 2 {
                break
            }
        }
        return parts.joined(separator: " ")
    }
}

enum ChatWorkingIdentity {
    static func resolve(
        sessionKey: String,
        pendingRunIDs: Set<String>,
        localUserMessageIDsByRunID: [String: UUID],
        fallbackGeneration: UInt64) -> String
    {
        if let messageID = pendingRunIDs.compactMap({ localUserMessageIDsByRunID[$0]?.uuidString }).min() {
            return "\(sessionKey):user:\(messageID)"
        }
        if let runID = pendingRunIDs.min() {
            return "\(sessionKey):run:\(runID)"
        }
        return "\(sessionKey):generation:\(fallbackGeneration)"
    }
}

struct ChatTurnRecap: Equatable, Sendable {
    let runtimeMs: Double
    let outputTokens: Int?
}

enum ChatTurnRecapText {
    static func done(runtimeMs: Double, locale: Locale = .current) -> String {
        String(
            format: String(localized: "Done in %@", locale: locale),
            locale: locale,
            ChatWorkingDurationFormatter.compact(milliseconds: runtimeMs))
    }

    static func tokens(_ outputTokens: Int?, locale: Locale = .current) -> String? {
        guard let outputTokens else { return nil }
        // Mirrors the web and American-English source contract: exactly one
        // uses the singular key; zero and every other count use the generic key.
        if outputTokens == 1 {
            return String(localized: "1 token", locale: locale)
        }
        return String(
            format: String(localized: "%@ tokens", locale: locale),
            locale: locale,
            outputTokens.formatted(.number.locale(locale)))
    }
}

struct ChatTurnRecapSessionRow: Equatable, Sendable {
    let status: String?
    let endedAt: Double?
    let runtimeMs: Double?
    let outputTokens: Int?

    init(
        status: String? = nil,
        endedAt: Double? = nil,
        runtimeMs: Double? = nil,
        outputTokens: Int? = nil)
    {
        self.status = status
        self.endedAt = endedAt
        self.runtimeMs = runtimeMs
        self.outputTokens = outputTokens
    }

    init(_ entry: OpenClawChatSessionEntry) {
        self.init(
            status: entry.status,
            endedAt: entry.endedAt,
            runtimeMs: entry.runtimeMs,
            outputTokens: entry.outputTokens)
    }
}

/// Watches the turn whose working indicator was visible. Most anomalous
/// interleavings fail quiet; without a row run ID, an unrelated completion
/// inside the settle window remains an accepted cosmetic attribution risk.
struct ChatTurnRecapResolver {
    private struct Watch {
        var watching: Bool
        var baselineKnown: Bool
        var baselineEndedAt: Double?
        var absorbedTerminal: Bool
        var settleStartedAt: Date?
        var settled: ChatTurnRecap?
    }

    private static let settleWindow: TimeInterval = 30
    private var watches: [String: Watch] = [:]

    mutating func resolve(
        sessionKey: String,
        indicatorVisible: Bool,
        row: ChatTurnRecapSessionRow?,
        now: Date = Date()) -> ChatTurnRecap?
    {
        var watch = self.watches[sessionKey]
        let rowEndedAt = row?.endedAt

        if indicatorVisible {
            if watch == nil || watch?.watching == false {
                watch = Watch(
                    watching: true,
                    baselineKnown: row != nil,
                    baselineEndedAt: rowEndedAt,
                    absorbedTerminal: false,
                    settleStartedAt: nil,
                    settled: nil)
            } else if watch?.baselineKnown == false {
                if row != nil {
                    watch?.baselineKnown = true
                    watch?.baselineEndedAt = rowEndedAt
                }
            } else if let rowEndedAt, rowEndedAt != watch?.baselineEndedAt {
                watch?.baselineEndedAt = rowEndedAt
                watch?.absorbedTerminal = true
            }
            self.watches[sessionKey] = watch
            return nil
        }

        guard var watch else { return nil }
        watch.watching = false
        if let settled = watch.settled {
            self.watches[sessionKey] = watch
            return settled
        }
        if watch.absorbedTerminal || !watch.baselineKnown {
            // Without an attributable baseline, later terminal rows could belong
            // to background work, so consume this watch unresolved.
            self.watches[sessionKey] = nil
            return nil
        }
        if let settleStartedAt = watch.settleStartedAt {
            if now.timeIntervalSince(settleStartedAt) > Self.settleWindow {
                self.watches[sessionKey] = nil
                return nil
            }
        } else {
            watch.settleStartedAt = now
        }

        let isStale: Bool = if let rowEndedAt, let baselineEndedAt = watch.baselineEndedAt {
            rowEndedAt <= baselineEndedAt
        } else {
            rowEndedAt == nil
        }
        if isStale {
            // Terminal stamps are monotonic. Equality and regression both mean
            // the watched run's terminal patch has not arrived yet.
            self.watches[sessionKey] = watch
            return nil
        }

        // Any fresh terminal concludes the watch. Only clean done rows with a
        // finite runtime produce a recap; waiting longer could attach another run.
        self.watches[sessionKey] = nil
        guard row?.status == "done", let runtimeMs = row?.runtimeMs, runtimeMs.isFinite else {
            return nil
        }
        let settled = ChatTurnRecap(runtimeMs: runtimeMs, outputTokens: row?.outputTokens)
        watch.settled = settled
        self.watches[sessionKey] = watch
        return settled
    }
}

private func fnv1a(_ key: String) -> UInt32 {
    var hash: UInt32 = 0x811C_9DC5
    for codeUnit in key.utf16 {
        hash ^= UInt32(codeUnit)
        hash = hash &* 0x0100_0193
    }
    return hash
}
