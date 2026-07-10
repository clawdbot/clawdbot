import Foundation

struct HostEnvOverrideDiagnostics: Equatable {
    var blockedKeys: [String]
    var invalidKeys: [String]
}

enum HostEnvSanitizer {
    /// Generated from src/infra/host-env-security-policy.json via scripts/generate-host-env-security-policy-swift.mjs.
    /// Parity is validated by src/infra/host-env-security.policy-parity.test.ts.
    private static let blockedInheritedKeys = HostEnvSecurityPolicy.blockedInheritedKeys
    private static let blockedInheritedPrefixes = HostEnvSecurityPolicy.blockedInheritedPrefixes
    private static let blockedKeys = HostEnvSecurityPolicy.blockedKeys
    private static let blockedPrefixes = HostEnvSecurityPolicy.blockedPrefixes
    private static let blockedOverrideKeys = HostEnvSecurityPolicy.blockedOverrideKeys
    private static let blockedOverridePrefixes = HostEnvSecurityPolicy.blockedOverridePrefixes
    private static let shellWrapperAllowedOverrideKeys: Set<String> = [
        "TERM",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "LC_MESSAGES",
        "COLORTERM",
        "NO_COLOR",
        "FORCE_COLOR",
    ]
    private static let gitAllowProtocolKey = "GIT_ALLOW_PROTOCOL"
    private static let gitProtocolFromUserKey = "GIT_PROTOCOL_FROM_USER"
    private static let gitProtocolFromUserDisabledValue = "0"
    private static let cargoTargetExecutableOverridePattern =
        #"^CARGO_TARGET_[A-Z0-9_]+_(LINKER|RUNNER)$"#
    private static let gitDefaultAlwaysAllowedProtocols: Set<String> = [
        "git",
        "http",
        "https",
        "ssh",
    ]

    private static func isBlocked(_ upperKey: String) -> Bool {
        if self.blockedKeys.contains(upperKey) {
            return true
        }
        return self.blockedPrefixes.contains(where: { upperKey.hasPrefix($0) })
    }

    private static func isBlockedInherited(_ upperKey: String) -> Bool {
        if self.blockedInheritedKeys.contains(upperKey) {
            return true
        }
        return self.blockedInheritedPrefixes.contains(where: { upperKey.hasPrefix($0) })
    }

    private static func isBlockedOverride(_ upperKey: String) -> Bool {
        if self.blockedOverrideKeys.contains(upperKey) {
            return true
        }
        if upperKey.range(
            of: self.cargoTargetExecutableOverridePattern,
            options: .regularExpression) != nil
        {
            return true
        }
        return self.blockedOverridePrefixes.contains(where: { upperKey.hasPrefix($0) })
    }

    private static func filterOverridesForShellWrapper(_ overrides: [String: String]?) -> [String: String]? {
        guard let overrides else { return nil }
        var filtered: [String: String] = [:]
        for (rawKey, value) in overrides {
            let key = rawKey.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !key.isEmpty else { continue }
            if self.shellWrapperAllowedOverrideKeys.contains(key.uppercased()) {
                filtered[key] = value
            }
        }
        return filtered.isEmpty ? nil : filtered
    }

    private static func isPortableHead(_ scalar: UnicodeScalar) -> Bool {
        let value = scalar.value
        return value == 95 || (65...90).contains(value) || (97...122).contains(value)
    }

    private static func isPortableTail(_ scalar: UnicodeScalar) -> Bool {
        let value = scalar.value
        return self.isPortableHead(scalar) || (48...57).contains(value)
    }

    private static func normalizeOverrideKey(_ rawKey: String) -> String? {
        let key = rawKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { return nil }
        guard let first = key.unicodeScalars.first, self.isPortableHead(first) else {
            return nil
        }
        for scalar in key.unicodeScalars.dropFirst() {
            if self.isPortableTail(scalar) || scalar == "(" || scalar == ")" {
                continue
            }
            return nil
        }
        return key
    }

    private static func sortedUnique(_ values: [String]) -> [String] {
        Array(Set(values)).sorted()
    }

    private static func isPermissiveGitProtocolFromUserValue(_ value: String) -> Bool {
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if normalized == "true" || normalized == "yes" || normalized == "on" {
            return true
        }
        let isInteger = normalized.range(of: #"^[+-]?[0-9]+$"#, options: .regularExpression) != nil
        let isZero = normalized.range(of: #"^[+-]?0+$"#, options: .regularExpression) != nil
        return isInteger && !isZero
    }

    private static func sanitizeInheritedGitAllowProtocolValue(_ value: String) -> String {
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if normalized.isEmpty {
            return ""
        }
        let safeProtocols = normalized
            .split(separator: ":", omittingEmptySubsequences: false)
            .filter { self.gitDefaultAlwaysAllowedProtocols.contains(String($0)) }
        return safeProtocols.joined(separator: ":")
    }

    static func inspectOverrides(
        overrides: [String: String]?,
        blockPathOverrides: Bool = true) -> HostEnvOverrideDiagnostics
    {
        guard let overrides else {
            return HostEnvOverrideDiagnostics(blockedKeys: [], invalidKeys: [])
        }

        var blocked: [String] = []
        var invalid: [String] = []
        for (rawKey, _) in overrides {
            let candidate = rawKey.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let normalized = self.normalizeOverrideKey(rawKey) else {
                invalid.append(candidate.isEmpty ? rawKey : candidate)
                continue
            }
            let upper = normalized.uppercased()
            if blockPathOverrides, upper == "PATH" {
                blocked.append(upper)
                continue
            }
            if self.isBlockedOverride(upper) || self.isBlocked(upper) {
                blocked.append(upper)
                continue
            }
        }

        return HostEnvOverrideDiagnostics(
            blockedKeys: self.sortedUnique(blocked),
            invalidKeys: self.sortedUnique(invalid))
    }

    static func sanitize(overrides: [String: String]?, shellWrapper: Bool = false) -> [String: String] {
        var merged: [String: String] = [:]
        for (rawKey, value) in ProcessInfo.processInfo.environment {
            let key = rawKey.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !key.isEmpty else { continue }
            let upper = key.uppercased()
            // Preserve inherited Git allowlists without widening malformed or unsafe entries by
            // deletion. Protocols outside Git's safe default set are removed instead.
            if upper == self.gitAllowProtocolKey {
                merged[key] = self.sanitizeInheritedGitAllowProtocolValue(value)
                continue
            }
            // Preserve non-permissive Git boolean values. Permissive values must become explicit
            // `0` because Git's unset default still permits protocols with policy `user`.
            if upper == self.gitProtocolFromUserKey {
                if !self.isPermissiveGitProtocolFromUserValue(value) {
                    merged[key] = value
                } else {
                    merged[key] = self.gitProtocolFromUserDisabledValue
                }
                continue
            }
            if self.isBlockedInherited(upper) {
                continue
            }
            merged[key] = value
        }

        let effectiveOverrides = shellWrapper
            ? self.filterOverridesForShellWrapper(overrides)
            : overrides

        guard let effectiveOverrides else { return merged }
        for (rawKey, value) in effectiveOverrides {
            guard let key = self.normalizeOverrideKey(rawKey) else { continue }
            let upper = key.uppercased()
            // PATH is part of the security boundary (command resolution + safe-bin checks). Never
            // allow request-scoped PATH overrides from agents/gateways.
            if upper == "PATH" {
                continue
            }
            if self.isBlockedOverride(upper) {
                continue
            }
            if self.isBlocked(upper) {
                continue
            }
            merged[key] = value
        }
        return merged
    }
}
