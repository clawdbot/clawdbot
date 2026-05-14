import CoreGraphics
import Foundation
import ImageIO
import OpenClawKit
import UniformTypeIdentifiers
import XCTest
@testable import OpenClawChatUI

private struct AttachmentProcessingTransport: OpenClawChatTransport {
    func requestHistory(sessionKey _: String) async throws -> OpenClawChatHistoryPayload {
        throw NSError(domain: "ChatViewModelAttachmentTests", code: 1)
    }

    func sendMessage(
        sessionKey _: String,
        message _: String,
        thinking _: String,
        idempotencyKey _: String,
        attachments _: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        throw NSError(domain: "ChatViewModelAttachmentTests", code: 2)
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        true
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        AsyncStream { _ in }
    }
}

private func makeChatAttachmentJPEG(width: Int, height: Int) throws -> Data {
    guard
        let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else {
        throw NSError(domain: "ChatViewModelAttachmentTests", code: 3)
    }

    context.setFillColor(CGColor(red: 0.2, green: 0.4, blue: 0.8, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.setFillColor(CGColor(red: 0.9, green: 0.5, blue: 0.1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width / 2, height: height / 2))

    guard let image = context.makeImage() else {
        throw NSError(domain: "ChatViewModelAttachmentTests", code: 4)
    }

    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else {
        throw NSError(domain: "ChatViewModelAttachmentTests", code: 5)
    }
    CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.95] as CFDictionary)
    guard CGImageDestinationFinalize(destination) else {
        throw NSError(domain: "ChatViewModelAttachmentTests", code: 6)
    }
    return data as Data
}

private func chatAttachmentDimensions(for data: Data) -> (width: Int, height: Int)? {
    guard
        let source = CGImageSourceCreateWithData(data as CFData, nil),
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
        let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
        let height = properties[kCGImagePropertyPixelHeight] as? NSNumber
    else {
        return nil
    }
    return (width.intValue, height.intValue)
}

final class ChatViewModelAttachmentTests: XCTestCase {
    func testImageAttachmentsAreProcessedBeforeStaging() async throws {
        let imageData = try makeChatAttachmentJPEG(width: 3000, height: 4000)
        let viewModel = await MainActor.run {
            OpenClawChatViewModel(sessionKey: "main", transport: AttachmentProcessingTransport())
        }

        await MainActor.run {
            viewModel.addImageAttachment(data: imageData, fileName: "camera.heic", mimeType: "image/jpeg")
        }

        try await waitUntil("attachment processed") {
            await MainActor.run { !viewModel.attachments.isEmpty || viewModel.errorText != nil }
        }

        let attachment = try await MainActor.run {
            guard let attachment = viewModel.attachments.first else {
                throw NSError(domain: "ChatViewModelAttachmentTests", code: 7)
            }
            return (attachment.fileName, attachment.mimeType, attachment.data)
        }
        let dimensions = try XCTUnwrap(chatAttachmentDimensions(for: attachment.2))

        XCTAssertEqual(attachment.0, "camera.jpg")
        XCTAssertEqual(attachment.1, "image/jpeg")
        XCTAssertLessThanOrEqual(attachment.2.count, ChatImageProcessor.maxPayloadBytes)
        XCTAssertLessThanOrEqual(max(dimensions.width, dimensions.height), ChatImageProcessor.maxLongEdgePx)
        let errorText = await MainActor.run { viewModel.errorText }
        XCTAssertNil(errorText)
    }
}
