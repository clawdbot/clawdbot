import AVFoundation
import CoreMedia
import Testing
@testable import OpenClaw

struct CameraDeviceResolverTests {
    @Test func `external portrait photos select the transposed format with the same encoding`() throws {
        let portrait = try Self.format(width: 1080, height: 1920)
        let formats = try [
            Self.format(width: 1920, height: 1080, subtype: kCVPixelFormatType_422YpCbCr8_yuvs),
            Self.format(width: 3840, height: 2160),
            Self.format(width: 1920, height: 1080),
        ]
        #expect(CameraDeviceResolver.landscapePhotoFormatIndex(
            deviceType: .external, activeFormat: portrait, formats: formats) == 2)
    }

    @Test(arguments: [AVCaptureDevice.DeviceType.builtInWideAngleCamera, .continuityCamera])
    func `non-external cameras retain portrait formats`(deviceType: AVCaptureDevice.DeviceType) throws {
        #expect(try CameraDeviceResolver.landscapePhotoFormatIndex(
            deviceType: deviceType,
            activeFormat: Self.format(width: 1080, height: 1920),
            formats: [Self.format(width: 1920, height: 1080)]) == nil)
    }

    @Test(arguments: [(1920, 1080), (1552, 1552), (1088, 1920)])
    func `landscape square and unmatched portrait formats remain unchanged`(width: Int32, height: Int32) throws {
        #expect(try CameraDeviceResolver.landscapePhotoFormatIndex(
            deviceType: .external,
            activeFormat: Self.format(width: width, height: height),
            formats: [
                Self.format(width: height, height: width, subtype: kCVPixelFormatType_422YpCbCr8_yuvs),
                Self.format(width: 1920, height: 1080),
            ]) == nil)
    }

    @Test func `external cameras without a matching encoding or format remain unchanged`() throws {
        let portrait = try Self.format(width: 1080, height: 1920)
        let wrongEncoding = try Self.format(width: 1920, height: 1080, subtype: kCVPixelFormatType_422YpCbCr8_yuvs)
        for formats in [[], [wrongEncoding]] {
            #expect(CameraDeviceResolver.landscapePhotoFormatIndex(
                deviceType: .external, activeFormat: portrait, formats: formats) == nil)
        }
    }

    private static func format(
        width: Int32,
        height: Int32,
        subtype: FourCharCode = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange) throws -> CMFormatDescription
    {
        var description: CMVideoFormatDescription?
        let result = CMVideoFormatDescriptionCreate(
            allocator: kCFAllocatorDefault,
            codecType: subtype,
            width: width,
            height: height,
            extensions: nil,
            formatDescriptionOut: &description)
        #expect(result == noErr)
        return try #require(description)
    }
}
