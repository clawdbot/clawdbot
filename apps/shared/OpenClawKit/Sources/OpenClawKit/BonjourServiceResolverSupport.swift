import Foundation

#if !os(watchOS)
public enum BonjourServiceResolverSupport {
    public static func start(_ service: NetService, timeout: TimeInterval = 2.0) {
        service.schedule(in: .main, forMode: .common)
        service.resolve(withTimeout: timeout)
    }

    public static func normalizeHost(_ raw: String?) -> String? {
        let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty else { return nil }
        return trimmed.hasSuffix(".") ? String(trimmed.dropLast()) : trimmed
    }
}
#endif
