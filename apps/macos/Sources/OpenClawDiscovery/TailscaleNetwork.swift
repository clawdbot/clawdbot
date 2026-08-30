import Foundation
import OpenClawKit

public enum TailscaleNetwork {
    public static func isTailnetIPv4(_ address: String) -> Bool {
        let parts = address.split(separator: ".")
        guard parts.count == 4 else { return false }
        let octets = parts.compactMap { Int($0) }
        guard octets.count == 4 else { return false }
        let a = octets[0]
        let b = octets[1]
        return a == 100 && b >= 64 && b <= 127
    }

    public static func detectTailnetIPv4() -> String? {
        for entry in NetworkInterfaceIPv4.addresses() where self.isTailnetIPv4(entry.ip) {
            return entry.ip
        }
        return nil
    }
}
