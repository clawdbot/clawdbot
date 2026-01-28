import Foundation

#if canImport(UIKit)
import UIKit
#endif

public enum InstanceIdentity {
    private static let suiteName = "bot.molt.shared"
    private static let legacySuiteName = "com.clawdbot.shared"
    private static let instanceIdKey = "instanceId"

    private static var defaults: UserDefaults {
        UserDefaults(suiteName: suiteName) ?? .standard
    }

    private static var legacyDefaults: UserDefaults? {
        UserDefaults(suiteName: legacySuiteName)
    }

#if canImport(UIKit)
    private static func readMainActor<T: Sendable>(_ body: @MainActor () -> T) -> T {
        if Thread.isMainThread {
            return MainActor.assumeIsolated { body() }
        }
        return DispatchQueue.main.sync {
            MainActor.assumeIsolated { body() }
        }
    }
#endif

    public static let instanceId: String = {
        let defaults = Self.defaults
        if let existing = defaults.string(forKey: instanceIdKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !existing.isEmpty
        {
            return existing
        }

        if let legacy = Self.legacyDefaults?.string(forKey: instanceIdKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !legacy.isEmpty
        {
            defaults.set(legacy, forKey: instanceIdKey)
            return legacy
        }

        let id = UUID().uuidString.lowercased()
        defaults.set(id, forKey: instanceIdKey)
        return id
    }()

    public static let displayName: String = {
#if canImport(UIKit)
        let name = Self.readMainActor {
            UIDevice.current.name.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return name.isEmpty ? "moltbot" : name
#else
        if let name = Host.current().localizedName?.trimmingCharacters(in: .whitespacesAndNewlines),
           !name.isEmpty
        {
            return name
        }
        return "moltbot"
#endif
    }()

    public static let modelIdentifier: String? = {
#if canImport(UIKit)
        var systemInfo = utsname()
        uname(&systemInfo)
        let machine = withUnsafeBytes(of: &systemInfo.machine) { ptr in
            String(bytes: ptr.prefix { $0 != 0 }, encoding: .utf8)
        }
        let trimmed = machine?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
#else
        var size = 0
        guard sysctlbyname("hw.model", nil, &size, nil, 0) == 0, size > 1 else { return nil }

        var buffer = [CChar](repeating: 0, count: size)
        guard sysctlbyname("hw.model", &buffer, &size, nil, 0) == 0 else { return nil }

        let bytes = buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }
        guard let raw = String(bytes: bytes, encoding: .utf8) else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
#endif
    }()

    public static let deviceFamily: String = {
#if canImport(UIKit)
        return Self.readMainActor {
            switch UIDevice.current.userInterfaceIdiom {
            case .pad: return "iPad"
            case .phone: return "iPhone"
            default: return "iOS"
            }
        }
#else
        return "Mac"
#endif
    }()

    public static let platformString: String = {
        let v = ProcessInfo.processInfo.operatingSystemVersion
#if canImport(UIKit)
        let name = Self.readMainActor {
            switch UIDevice.current.userInterfaceIdiom {
            case .pad: return "iPadOS"
            case .phone: return "iOS"
            default: return "iOS"
            }
        }
        return "\(name) \(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
#else
        return "macOS \(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
#endif
    }()
}
