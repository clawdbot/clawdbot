import Foundation
import ImageIO
import SwiftUI

#if canImport(AppKit)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

enum ChatMediaImageDecoder {
    static let maximumThumbnailPixels = 2048

    static func decode(_ data: Data) -> OpenClawPlatformImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              CGImageSourceGetCount(source) > 0
        else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: self.maximumThumbnailPixels,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
        else { return nil }
        #if canImport(AppKit)
        return NSImage(cgImage: cgImage, size: .zero)
        #elseif canImport(UIKit)
        return UIImage(cgImage: cgImage)
        #endif
    }
}

@MainActor
struct ChatMediaImageAttachment: View {
    private enum LoadState {
        case loading
        case loaded(OpenClawPlatformImage)
        case unavailable
    }

    let artifactId: String
    let label: String
    let resolverReady: Bool
    let load: @MainActor @Sendable (String) async throws -> OpenClawChatLoadedMedia?

    @State private var state: LoadState = .loading
    @State private var retryGeneration = 0
    @State private var showsFullImage = false

    var body: some View {
        Group {
            switch self.state {
            case .loading:
                HStack(spacing: 8) {
                    ProgressView()
                    Text(String(localized: "Loading image…"))
                        .font(OpenClawChatTypography.footnote)
                        .foregroundStyle(.secondary)
                }
                .frame(minHeight: 88)
                .frame(maxWidth: .infinity)
            case let .loaded(image):
                Button {
                    self.showsFullImage = true
                } label: {
                    OpenClawPlatformImageFactory.image(image)
                        .resizable()
                        .scaledToFit()
                        .frame(maxHeight: 320)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .strokeBorder(Color.white.opacity(0.12), lineWidth: 1))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(self.label)
                .accessibilityHint(String(localized: "Opens image preview"))
                .sheet(isPresented: self.$showsFullImage) {
                    ZStack(alignment: .topTrailing) {
                        Color.black.ignoresSafeArea()
                        ScrollView([.horizontal, .vertical]) {
                            OpenClawPlatformImageFactory.image(image)
                                .resizable()
                                .scaledToFit()
                                .padding(20)
                        }
                        Button {
                            self.showsFullImage = false
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.title2)
                                .symbolRenderingMode(.hierarchical)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(.white)
                        .padding(16)
                        .accessibilityLabel(String(localized: "Close image preview"))
                    }
                }
            case .unavailable:
                HStack(spacing: 8) {
                    Image(systemName: "photo.badge.exclamationmark")
                    Text(String(localized: "Image unavailable"))
                        .font(OpenClawChatTypography.footnote)
                    Spacer()
                    Button {
                        self.retryGeneration &+= 1
                    } label: {
                        Text(String(localized: "Retry"))
                            .font(OpenClawChatTypography.footnote)
                    }
                    .buttonStyle(.plain)
                }
                .foregroundStyle(.secondary)
                .padding(10)
                .background(Color.black.opacity(0.04))
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
        }
        .task(id: "\(self.artifactId):\(self.resolverReady):\(self.retryGeneration)") {
            await self.loadImage()
        }
    }

    private func loadImage() async {
        guard self.resolverReady else {
            self.state = .unavailable
            return
        }
        self.state = .loading
        do {
            guard let loaded = try await self.load(self.artifactId), !Task.isCancelled else {
                if !Task.isCancelled { self.state = .unavailable }
                return
            }
            guard case let .data(media) = loaded,
                  media.mimeType.lowercased().hasPrefix("image/")
            else {
                self.state = .unavailable
                return
            }
            let image = await Task.detached(priority: .userInitiated) {
                ChatMediaImageDecoder.decode(media.data)
            }.value
            guard !Task.isCancelled else { return }
            self.state = image.map(LoadState.loaded) ?? .unavailable
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled else { return }
            self.state = .unavailable
        }
    }
}
