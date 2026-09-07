import Foundation

public enum CaptureRateLimits {
    public static func clampDurationMs(
        _ ms: Int?,
        defaultMs: Int = 10000,
        minMs: Int = 250,
        maxMs: Int = 60000) -> Int
    {
        let value = ms ?? defaultMs
        return min(maxMs, max(minMs, value))
    }

    public static func clampFps(
        _ fps: Double?,
        defaultFps: Double = 10,
        minFps: Double = 1,
        maxFps: Double) -> Double
    {
        let value = fps ?? defaultFps
        guard value.isFinite else { return defaultFps }
        return min(maxFps, max(minFps, value))
    }
}
