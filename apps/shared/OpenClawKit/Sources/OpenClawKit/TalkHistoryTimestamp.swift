public enum TalkHistoryTimestamp: Sendable {
    /// Gateway history timestamps have historically been emitted as either seconds (Double, epoch seconds)
    /// or milliseconds (Double, epoch ms). This helper accepts either.
    public static func isAfter(_ timestamp: Double, sinceSeconds: Double) -> Bool {
        let sinceMs = sinceSeconds * 1000
        // ~2286-11-20 in epoch seconds. Anything bigger is almost certainly epoch milliseconds.
        if timestamp > 10_000_000_000 {
            return timestamp >= sinceMs - 500
        }
        return timestamp >= sinceSeconds - 0.5
    }
}
