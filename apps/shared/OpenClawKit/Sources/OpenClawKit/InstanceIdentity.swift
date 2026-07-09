import Foundation

#if os(iOS)
import UIKit
#elseif os(watchOS)
import WatchKit
#endif

public enum InstanceIdentity {
    private static let suiteName = "ai.openclaw.shared"
    private static let instanceIdKey = "instanceId"

    private static var defaults: UserDefaults {
        UserDefaults(suiteName: suiteName) ?? .standard
    }

    #if os(iOS) || os(watchOS)
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

        let id = UUID().uuidString.lowercased()
        defaults.set(id, forKey: instanceIdKey)
        return id
    }()

    public static let displayName: String = {
        #if os(iOS)
        let name = Self.readMainActor {
            UIDevice.current.name.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return name.isEmpty ? "openclaw" : name
        #elseif os(watchOS)
        let name = Self.readMainActor {
            WKInterfaceDevice.current().name.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return name.isEmpty ? "Apple Watch" : name
        #else
        if let name = Host.current().localizedName?.trimmingCharacters(in: .whitespacesAndNewlines),
           !name.isEmpty
        {
            return name
        }
        return "openclaw"
        #endif
    }()

    public static let modelIdentifier: String? = {
        #if os(iOS) || os(watchOS)
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
        #if os(iOS)
        return Self.readMainActor {
            switch UIDevice.current.userInterfaceIdiom {
            case .pad: "iPad"
            case .phone: "iPhone"
            default: "iOS"
            }
        }
        #elseif os(watchOS)
        return "Apple Watch"
        #else
        return "Mac"
        #endif
    }()

    public static let platformString: String = {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        #if os(iOS)
        let name = Self.readMainActor {
            switch UIDevice.current.userInterfaceIdiom {
            case .pad: "iPadOS"
            case .phone: "iOS"
            default: "iOS"
            }
        }
        return "\(name) \(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
        #elseif os(watchOS)
        return "watchOS \(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
        #else
        return "macOS \(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
        #endif
    }()
}
