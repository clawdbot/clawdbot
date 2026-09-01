#if os(macOS)
import AppKit
import Foundation
import Testing
@testable import OpenClawChatUI

@Suite(.serialized)
@MainActor
struct ChatComposerPasteSupportTests {
    @Test func extractsImageDataFromPNGClipboardPayload() throws {
        let pasteboard = NSPasteboard(name: NSPasteboard.Name("test-\(UUID().uuidString)"))
        let item = NSPasteboardItem()
        let pngData = try self.samplePNGData()

        pasteboard.clearContents()
        item.setData(pngData, forType: .png)
        #expect(pasteboard.writeObjects([item]))

        let attachments = ChatComposerPasteSupport.imageAttachments(from: pasteboard)

        #expect(attachments.count == 1)
        #expect(attachments[0].data == pngData)
        #expect(attachments[0].fileName == "pasted-image-1.png")
        #expect(attachments[0].mimeType == "image/png")
    }

    @Test func extractsImageDataFromFileURLClipboardPayload() throws {
        let pasteboard = NSPasteboard(name: NSPasteboard.Name("test-\(UUID().uuidString)"))
        let pngData = try self.samplePNGData()
        let fileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("chat-composer-paste-\(UUID().uuidString).png")

        try pngData.write(to: fileURL)
        defer { try? FileManager.default.removeItem(at: fileURL) }

        pasteboard.clearContents()
        #expect(pasteboard.writeObjects([fileURL as NSURL]))

        let references = ChatComposerPasteSupport.imageFileReferences(from: pasteboard)
        let attachments = ChatComposerPasteSupport.loadImageAttachments(from: references)

        #expect(references.count == 1)
        #expect(references[0].url == fileURL)
        #expect(attachments.count == 1)
        #expect(attachments[0].data == pngData)
        #expect(attachments[0].fileName == fileURL.lastPathComponent)
        #expect(attachments[0].mimeType == "image/png")
    }

    private func samplePNGData() throws -> Data {
        let image = NSImage(size: NSSize(width: 4, height: 4))
        image.lockFocus()
        NSColor.systemBlue.setFill()
        NSBezierPath(rect: NSRect(x: 0, y: 0, width: 4, height: 4)).fill()
        image.unlockFocus()

        let tiffData = try #require(image.tiffRepresentation)
        let bitmap = try #require(NSBitmapImageRep(data: tiffData))
        return try #require(bitmap.representation(using: .png, properties: [:]))
    }
}
#endif
