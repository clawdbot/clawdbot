import Foundation
import UIKit

enum NodeDisplayName {
    private static let genericNames: Set<String> = ["iOS Node", "iPhone Node", "iPad Node"]

    static func isGeneric(_ name: String) -> Bool {
        self.genericNames.contains(name)
    }

    static func defaultValue(for interfaceIdiom: UIUserInterfaceIdiom) -> String {
        switch interfaceIdiom {
        case .phone:
            "iPhone Node"
        case .pad:
            "iPad Node"
        default:
            "iOS Node"
        }
    }

    static func resolve(
        existing: String?,
        deviceName: String,
        interfaceIdiom: UIUserInterfaceIdiom) -> String
    {
        let trimmedExisting = existing?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmedExisting.isEmpty, !Self.isGeneric(trimmedExisting) {
            return trimmedExisting
        }

        let trimmedDevice = deviceName.trimmingCharacters(in: .whitespacesAndNewlines)
        if let normalized = Self.normalizedDeviceName(trimmedDevice) {
            return normalized
        }

        return Self.defaultValue(for: interfaceIdiom)
    }

    private static func normalizedDeviceName(_ deviceName: String) -> String? {
        guard !deviceName.isEmpty else { return nil }
        let lower = deviceName.lowercased()
        if lower.contains("iphone") || lower.contains("ipad") || lower.contains("ios") {
            return deviceName
        }
        return nil
    }
}
