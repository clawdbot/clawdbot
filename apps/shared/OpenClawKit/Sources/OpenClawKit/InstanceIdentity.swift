import Foundation

#if os(iOS)
import UIKit
#elseif os(watchOS)
import WatchKit
#endif

enum AppleMobileInterfaceIdiom: Sendable {
    case phone
    case pad
    case other
}

struct AppleMobileInstanceMetadata: Equatable, Sendable {
    let platformString: String
    let deviceFamily: String
    let modelIdentifier: String?

    static func resolve(
        version: OperatingSystemVersion,
        interfaceIdiom: AppleMobileInterfaceIdiom,
        isIOSAppOnMac: Bool,
        rawModelIdentifier: String?) -> Self
    {
        let versionString = "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)"
        let trimmedModel = rawModelIdentifier?.trimmingCharacters(in: .whitespacesAndNewlines)

        if isIOSAppOnMac {
            // Keep the iOS protocol family so the gateway applies the mobile
            // command policy, while making the compatibility host explicit.
            return Self(
                platformString: "iOS \(versionString)",
                deviceFamily: "iOS",
                modelIdentifier: "Apple Silicon Mac")
        }

        let identity = switch interfaceIdiom {
        case .phone:
            (platform: "iOS", family: "iPhone")
        case .pad:
            (platform: "iPadOS", family: "iPad")
        case .other:
            (platform: "iOS", family: "iOS")
        }
        return Self(
            platformString: "\(identity.platform) \(versionString)",
            deviceFamily: identity.family,
            modelIdentifier: trimmedModel?.isEmpty == false ? trimmedModel : nil)
    }
}

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

    #if os(iOS)
    private static let appleMobileMetadata: AppleMobileInstanceMetadata = {
        let interfaceIdiom = Self.readMainActor {
            switch UIDevice.current.userInterfaceIdiom {
            case .phone: AppleMobileInterfaceIdiom.phone
            case .pad: AppleMobileInterfaceIdiom.pad
            default: AppleMobileInterfaceIdiom.other
            }
        }
        return AppleMobileInstanceMetadata.resolve(
            version: ProcessInfo.processInfo.operatingSystemVersion,
            interfaceIdiom: interfaceIdiom,
            isIOSAppOnMac: ProcessInfo.processInfo.isiOSAppOnMac,
            rawModelIdentifier: Self.mobileMachineIdentifier())
    }()
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
        if ProcessInfo.processInfo.isiOSAppOnMac {
            return "OpenClaw Mac App"
        }
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
        #if os(iOS)
        return Self.appleMobileMetadata.modelIdentifier
        #elseif os(watchOS)
        return Self.mobileMachineIdentifier()
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

    #if os(iOS) || os(watchOS)
    private static func mobileMachineIdentifier() -> String? {
        var systemInfo = utsname()
        uname(&systemInfo)
        let machine = withUnsafeBytes(of: &systemInfo.machine) { ptr in
            String(bytes: ptr.prefix { $0 != 0 }, encoding: .utf8)
        }
        let trimmed = machine?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
    #endif

    public static let deviceFamily: String = {
        #if os(iOS)
        return Self.appleMobileMetadata.deviceFamily
        #elseif os(watchOS)
        return "Apple Watch"
        #else
        return "Mac"
        #endif
    }()

    public static let platformString: String = {
        #if os(iOS)
        return Self.appleMobileMetadata.platformString
        #elseif os(watchOS)
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return "watchOS \(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
        #else
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return "macOS \(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
        #endif
    }()
}
