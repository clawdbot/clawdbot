enum WatchDeferredPayloadOrdering {
    static func isExpired(expiresAtMs: Int64?, nowMs: Int64) -> Bool {
        expiresAtMs.map { $0 <= nowMs } == true
    }

    static func isNewerThanSnapshot(payloadSentAtMs: Int64?, snapshotSentAtMs: Int64?) -> Bool {
        guard let payloadSentAtMs, let snapshotSentAtMs else { return true }
        return payloadSentAtMs > snapshotSentAtMs
    }

    static func isAtOrBeforeSnapshot(payloadSentAtMs: Int64?, snapshotSentAtMs: Int64?) -> Bool {
        guard let snapshotSentAtMs else { return false }
        return payloadSentAtMs.map { $0 <= snapshotSentAtMs } ?? true
    }

    static func indicesOldestFirst(for timestamps: [Int64?]) -> [Int] {
        timestamps.indices.sorted { lhs, rhs in
            let lhsTimestamp = timestamps[lhs] ?? .min
            let rhsTimestamp = timestamps[rhs] ?? .min
            if lhsTimestamp != rhsTimestamp {
                return lhsTimestamp < rhsTimestamp
            }
            return lhs < rhs
        }
    }
}
