import AppKit
import Foundation
import SwiftUI

@MainActor
enum OnboardingProviderIcon {
    private static let resourceBundle: Bundle? = locateResourceBundle()
    private static var imageCache: [String: NSImage] = [:]

    static func resourceURL(for kind: String) -> URL? {
        guard let name = resourceName(for: kind) else { return nil }
        return self.resourceBundle?.url(
            forResource: name,
            withExtension: "svg",
            subdirectory: "ProviderIcons")
    }

    static func image(for kind: String) -> NSImage? {
        guard let name = resourceName(for: kind) else { return nil }
        if let image = self.imageCache[name] {
            return image
        }
        guard let url = self.resourceBundle?.url(
            forResource: name,
            withExtension: "svg",
            subdirectory: "ProviderIcons"),
            let image = NSImage(contentsOf: url)
        else { return nil }
        image.isTemplate = true
        self.imageCache[name] = image
        return image
    }

    static func image(brandCandidates: [String?]) -> NSImage? {
        brandCandidates.lazy.compactMap(\.self).compactMap { self.image(for: $0) }.first
    }

    private static func resourceName(for kind: String) -> String? {
        let normalized = kind.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if let name = self.brandResourceName(normalized) {
            return name
        }
        // Auth/provider choice ids compose the brand with a method suffix
        // ("xai-oauth", "anthropic-vertex"); fall back to the leading token.
        guard let brand = normalized.split(separator: "-").first, brand != normalized[...]
        else { return nil }
        return self.brandResourceName(String(brand))
    }

    private static func brandResourceName(_ normalized: String) -> String? {
        switch normalized {
        case "claude-cli", "claude-code", "claude", "anthropic": "ProviderIcon-claude"
        case "codex-cli", "codex", "openai", "chatgpt": "ProviderIcon-codex"
        case "gemini-cli", "gemini", "googlegemini", "google": "ProviderIcon-gemini"
        case "ollama": "ProviderIcon-ollama"
        case "lmstudio", "lm-studio": "ProviderIcon-lmstudio"
        case "pi": "ProviderIcon-pi"
        case "opencode": "ProviderIcon-opencode"
        case "kimi-code", "kimi", "moonshot": "ProviderIcon-kimi"
        case "grok-build", "grok", "xai": "ProviderIcon-xai"
        default: nil
        }
    }

    private static func locateResourceBundle() -> Bundle? {
        if self.bundleContainsProviderIcons(Bundle.main) {
            return Bundle.main
        }
        // Packaged apps copy these vectors into Bundle.main. SwiftPM's generated
        // Bundle.module accessor can fatalError when that sidecar is absent.
        if Bundle.main.bundleURL.pathExtension != "app",
           self.bundleContainsProviderIcons(Bundle.module)
        {
            return Bundle.module
        }
        return nil
    }

    private static func bundleContainsProviderIcons(_ bundle: Bundle) -> Bool {
        bundle.url(
            forResource: "ProviderIcon-claude",
            withExtension: "svg",
            subdirectory: "ProviderIcons") != nil
    }
}

@MainActor
enum OnboardingRemoteProviderIcon {
    struct LoadedIcon {
        let nsImage: NSImage
        let isVector: Bool
    }

    private static var cache: [String: LoadedIcon] = [:]

    static func load(_ url: URL) async -> LoadedIcon? {
        let key = url.absoluteString
        if let cached = self.cache[key] {
            return cached
        }
        guard let (data, _) = try? await URLSession.shared.data(from: url),
              let icon = self.decode(data)
        else { return nil }
        self.cache[key] = icon
        return icon
    }

    static func decode(_ data: Data) -> LoadedIcon? {
        let isVector = self.isVector(data)
        guard let image = NSImage(data: data) else { return nil }
        image.isTemplate = isVector
        return LoadedIcon(nsImage: image, isVector: isVector)
    }

    private static func isVector(_ data: Data) -> Bool {
        // XML declarations, comments, and doctypes routinely precede the <svg>
        // root (simpleicons, exported assets); scan the bounded prolog for it.
        let bytes = Array(data.prefix(512))
        var index = bytes.starts(with: [0xEF, 0xBB, 0xBF]) ? 3 : 0
        func skip(past terminator: [UInt8]) -> Bool {
            while index + terminator.count <= bytes.count {
                if Array(bytes[index..<index + terminator.count]) == terminator {
                    index += terminator.count
                    return true
                }
                index += 1
            }
            return false
        }
        while index < bytes.count {
            while index < bytes.count, [0x09, 0x0A, 0x0C, 0x0D, 0x20].contains(bytes[index]) {
                index += 1
            }
            guard let head = String(bytes: bytes[index...].prefix(9), encoding: .utf8)?.lowercased()
            else { return false }
            if head.hasPrefix("<svg") { return true }
            if head.hasPrefix("<?xml") {
                guard skip(past: Array("?>".utf8)) else { return false }
            } else if head.hasPrefix("<!--") {
                guard skip(past: Array("-->".utf8)) else { return false }
            } else if head.hasPrefix("<!doctype") {
                guard skip(past: Array(">".utf8)) else { return false }
            } else {
                return false
            }
        }
        return false
    }
}

struct OnboardingProviderArtwork: View {
    let icon: String?
    let brandCandidates: [String?]
    let fallbackSymbol: String
    var wellSize: CGFloat = 32
    var iconSize: CGFloat = 18

    @State private var remoteIcon: OnboardingRemoteProviderIcon.LoadedIcon?

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color.primary.opacity(0.06))
            self.glyph
                .frame(width: self.iconSize, height: self.iconSize)
        }
        .frame(width: self.wellSize, height: self.wellSize)
        .task(id: [self.icon] + self.brandCandidates) {
            self.remoteIcon = nil
            guard OnboardingProviderIcon.image(brandCandidates: self.brandCandidates) == nil,
                  let url = OnboardingProviderAuthLink.safeURL(self.icon)
            else { return }
            let loaded = await OnboardingRemoteProviderIcon.load(url)
            guard !Task.isCancelled else { return }
            self.remoteIcon = loaded
        }
    }

    @ViewBuilder
    private var glyph: some View {
        if let image = OnboardingProviderIcon.image(brandCandidates: self.brandCandidates) {
            Image(nsImage: image)
                .renderingMode(.template)
                .resizable()
                .scaledToFit()
                .foregroundStyle(.primary)
        } else if let remoteIcon, remoteIcon.isVector {
            Image(nsImage: remoteIcon.nsImage)
                .renderingMode(.template)
                .resizable()
                .scaledToFit()
                .foregroundStyle(.primary)
        } else if let remoteIcon {
            Image(nsImage: remoteIcon.nsImage)
                .renderingMode(.original)
                .resizable()
                .scaledToFit()
                .clipShape(RoundedRectangle(cornerRadius: 4))
        } else {
            Image(systemName: self.fallbackSymbol)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.secondary)
        }
    }
}
