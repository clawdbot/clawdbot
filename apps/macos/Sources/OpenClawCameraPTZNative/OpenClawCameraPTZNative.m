#import "OpenClawCameraPTZNative.h"

#import <CoreFoundation/CoreFoundation.h>
#import <IOKit/IOCFPlugIn.h>
#import <IOKit/IOKitLib.h>
#import <IOKit/usb/IOUSBLib.h>
#import <IOKit/usb/IOUSBHostFamilyDefinitions.h>

#include <mach/mach_error.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>

enum {
    OpenClawUVCVideoClass = 0x0e,
    OpenClawUVCVideoControlSubclass = 0x01,
    OpenClawUVCClassInterfaceDescriptor = 0x24,
    OpenClawUVCVideoControlHeader = 0x01,
    OpenClawUVCInputTerminal = 0x02,
    OpenClawUVCInputTerminalCamera = 0x0201,
    OpenClawUVCSetCurrent = 0x01,
};

struct OpenClawUVCController {
    IOUSBDeviceInterface **device;
    IOUSBInterfaceInterface220 **interface;
    uint8_t interface_number;
    uint8_t terminal_id;
    int interface_open;
};

static void OpenClawUVCSetError(char **error_out, const char *format, ...) {
    if (error_out == NULL) {
        return;
    }
    va_list args;
    va_start(args, format);
    if (vasprintf(error_out, format, args) < 0) {
        *error_out = NULL;
    }
    va_end(args);
}

static uint32_t OpenClawUVCNumberProperty(io_service_t service, CFStringRef key) {
    CFTypeRef property = IORegistryEntryCreateCFProperty(service, key, kCFAllocatorDefault, 0);
    if (property == NULL) {
        return 0;
    }
    int64_t value = 0;
    if (CFGetTypeID(property) == CFNumberGetTypeID()) {
        CFNumberGetValue((CFNumberRef)property, kCFNumberSInt64Type, &value);
    }
    CFRelease(property);
    return (uint32_t)value;
}

static IOUSBDeviceInterface **OpenClawUVCCreateDeviceInterface(
    uint32_t location_id,
    uint16_t vendor_id,
    uint16_t product_id,
    IOReturn *failure_out
) {
    const char *class_names[] = {kIOUSBHostDeviceClassName, kIOUSBDeviceClassName};
    IOReturn last_failure = kIOReturnNotFound;

    for (size_t class_index = 0; class_index < sizeof(class_names) / sizeof(class_names[0]); class_index++) {
        CFMutableDictionaryRef matching = IOServiceMatching(class_names[class_index]);
        if (matching == NULL) {
            continue;
        }
        io_iterator_t iterator = IO_OBJECT_NULL;
        IOReturn result = IOServiceGetMatchingServices(kIOMainPortDefault, matching, &iterator);
        if (result != kIOReturnSuccess) {
            last_failure = result;
            continue;
        }

        io_service_t service;
        while ((service = IOIteratorNext(iterator)) != IO_OBJECT_NULL) {
            uint32_t found_vendor = OpenClawUVCNumberProperty(service, CFSTR(kUSBVendorID));
            uint32_t found_product = OpenClawUVCNumberProperty(service, CFSTR(kUSBProductID));
            uint32_t found_location = OpenClawUVCNumberProperty(service, CFSTR(kUSBDevicePropertyLocationID));
            if (found_vendor != vendor_id || found_product != product_id || found_location != location_id) {
                IOObjectRelease(service);
                continue;
            }

            IOCFPlugInInterface **plugin = NULL;
            SInt32 score = 0;
            result = IOCreatePlugInInterfaceForService(
                service,
                kIOUSBDeviceUserClientTypeID,
                kIOCFPlugInInterfaceID,
                &plugin,
                &score
            );
            IOObjectRelease(service);
            if (result != kIOReturnSuccess || plugin == NULL) {
                if (plugin != NULL) {
                    (*plugin)->Release(plugin);
                }
                last_failure = result;
                continue;
            }

            IOUSBDeviceInterface **device = NULL;
            HRESULT query_result = (*plugin)->QueryInterface(
                plugin,
                CFUUIDGetUUIDBytes(kIOUSBDeviceInterfaceID),
                (LPVOID *)&device
            );
            (*plugin)->Release(plugin);
            if (query_result == S_OK && device != NULL) {
                IOObjectRelease(iterator);
                return device;
            }
            if (device != NULL) {
                (*device)->Release(device);
            }
            last_failure = (IOReturn)query_result;
        }
        IOObjectRelease(iterator);
    }

    if (failure_out != NULL) {
        *failure_out = last_failure;
    }
    return NULL;
}

static int OpenClawUVCParseCameraTerminalDescriptor(
    const uint8_t *descriptor,
    size_t descriptor_length,
    uint8_t *terminal_id_out,
    uint32_t *controls_out
) {
    // Absolute zoom and pan/tilt are bits 9 and 11. Read only their two bytes;
    // IOUSBLib's associated-descriptor iterator exposes one descriptor at a time.
    if (descriptor == NULL || terminal_id_out == NULL || controls_out == NULL || descriptor_length < 17 ||
        descriptor[0] < 17 || descriptor[0] > descriptor_length ||
        descriptor[1] != OpenClawUVCClassInterfaceDescriptor || descriptor[2] != OpenClawUVCInputTerminal) {
        return 0;
    }

    uint16_t terminal_type = (uint16_t)descriptor[4] | ((uint16_t)descriptor[5] << 8);
    size_t control_size = descriptor[14];
    if (terminal_type != OpenClawUVCInputTerminalCamera || control_size < 2 ||
        control_size > (size_t)descriptor[0] - 15) {
        return 0;
    }

    *terminal_id_out = descriptor[3] == 0 ? 1 : descriptor[3];
    *controls_out = (uint32_t)descriptor[15] | ((uint32_t)descriptor[16] << 8);
    return 1;
}

int openclaw_uvc_parse_camera_terminal(
    const uint8_t *descriptors,
    size_t descriptors_length,
    uint8_t *terminal_id_out,
    uint32_t *controls_out
) {
    if (descriptors == NULL || terminal_id_out == NULL || controls_out == NULL || descriptors_length < 7 ||
        descriptors[0] < 7 || descriptors[1] != OpenClawUVCClassInterfaceDescriptor ||
        descriptors[2] != OpenClawUVCVideoControlHeader) {
        return 0;
    }

    size_t scan_length = (size_t)descriptors[5] | ((size_t)descriptors[6] << 8);
    if (scan_length > descriptors_length) {
        scan_length = descriptors_length;
    }
    for (size_t offset = 0; offset < scan_length;) {
        const uint8_t *descriptor = descriptors + offset;
        size_t length = descriptor[0];
        if (length == 0 || length > scan_length - offset) {
            return 0;
        }
        if (OpenClawUVCParseCameraTerminalDescriptor(
                descriptor,
                length,
                terminal_id_out,
                controls_out
            )) {
            return 1;
        }
        offset += length;
    }
    return 0;
}

static void OpenClawUVCReadTerminal(
    IOUSBInterfaceInterface220 **interface,
    uint8_t *terminal_id_out,
    uint32_t *controls_out
) {
    *terminal_id_out = 1;
    *controls_out = 0;

    IOUSBDescriptorHeader *current = NULL;
    while ((current = (*interface)->FindNextAssociatedDescriptor(
                interface,
                current,
                OpenClawUVCClassInterfaceDescriptor
            )) != NULL) {
        if (OpenClawUVCParseCameraTerminalDescriptor(
                (const uint8_t *)current,
                current->bLength,
                terminal_id_out,
                controls_out
            )) {
            return;
        }
    }
}

int openclaw_uvc_open(
    uint32_t location_id,
    uint16_t vendor_id,
    uint16_t product_id,
    OpenClawUVCController **controller_out,
    uint32_t *controls_out,
    char **error_out
) {
    if (controller_out == NULL || controls_out == NULL) {
        OpenClawUVCSetError(error_out, "invalid controller output pointers");
        return 0;
    }
    *controller_out = NULL;
    *controls_out = 0;

    IOReturn result = kIOReturnSuccess;
    IOUSBDeviceInterface **device = OpenClawUVCCreateDeviceInterface(
        location_id,
        vendor_id,
        product_id,
        &result
    );
    if (device == NULL) {
        OpenClawUVCSetError(
            error_out,
            "USB device %04x:%04x at location 0x%08x not found (%s, 0x%08x)",
            vendor_id,
            product_id,
            location_id,
            mach_error_string(result),
            result
        );
        return 0;
    }

    IOUSBFindInterfaceRequest request = {
        OpenClawUVCVideoClass,
        OpenClawUVCVideoControlSubclass,
        kIOUSBFindInterfaceDontCare,
        kIOUSBFindInterfaceDontCare,
    };
    io_iterator_t iterator = IO_OBJECT_NULL;
    result = (*device)->CreateInterfaceIterator(device, &request, &iterator);
    if (result != kIOReturnSuccess) {
        (*device)->Release(device);
        OpenClawUVCSetError(error_out, "find VideoControl interface: %s (0x%08x)", mach_error_string(result), result);
        return 0;
    }

    io_service_t service = IOIteratorNext(iterator);
    IOObjectRelease(iterator);
    if (service == IO_OBJECT_NULL) {
        (*device)->Release(device);
        OpenClawUVCSetError(error_out, "USB device has no UVC VideoControl interface");
        return 0;
    }

    IOCFPlugInInterface **plugin = NULL;
    SInt32 score = 0;
    result = IOCreatePlugInInterfaceForService(
        service,
        kIOUSBInterfaceUserClientTypeID,
        kIOCFPlugInInterfaceID,
        &plugin,
        &score
    );
    IOObjectRelease(service);
    if (result != kIOReturnSuccess || plugin == NULL) {
        if (plugin != NULL) {
            (*plugin)->Release(plugin);
        }
        (*device)->Release(device);
        OpenClawUVCSetError(error_out, "create VideoControl interface: %s (0x%08x)", mach_error_string(result), result);
        return 0;
    }

    IOUSBInterfaceInterface220 **interface = NULL;
    HRESULT query_result = (*plugin)->QueryInterface(
        plugin,
        CFUUIDGetUUIDBytes(kIOUSBInterfaceInterfaceID220),
        (LPVOID *)&interface
    );
    (*plugin)->Release(plugin);
    if (query_result != S_OK || interface == NULL) {
        if (interface != NULL) {
            (*interface)->Release(interface);
        }
        (*device)->Release(device);
        OpenClawUVCSetError(error_out, "query VideoControl interface: 0x%08x", (unsigned int)query_result);
        return 0;
    }

    uint8_t interface_number = 0;
    result = (*interface)->GetInterfaceNumber(interface, &interface_number);
    if (result != kIOReturnSuccess) {
        (*interface)->Release(interface);
        (*device)->Release(device);
        OpenClawUVCSetError(error_out, "read VideoControl interface number: %s (0x%08x)", mach_error_string(result), result);
        return 0;
    }

    int interface_open = 0;
    result = (*interface)->USBInterfaceOpen(interface);
    if (result == kIOReturnSuccess) {
        interface_open = 1;
    } else if (result != kIOReturnExclusiveAccess) {
        (*interface)->Release(interface);
        (*device)->Release(device);
        OpenClawUVCSetError(error_out, "open VideoControl interface: %s (0x%08x)", mach_error_string(result), result);
        return 0;
    }
    // AVFoundation may already own the interface. UVC class requests can still
    // succeed through the queried interface, which we must not close ourselves.

    OpenClawUVCController *controller = calloc(1, sizeof(OpenClawUVCController));
    if (controller == NULL) {
        if (interface_open) {
            (*interface)->USBInterfaceClose(interface);
        }
        (*interface)->Release(interface);
        (*device)->Release(device);
        OpenClawUVCSetError(error_out, "allocate UVC controller");
        return 0;
    }

    controller->device = device;
    controller->interface = interface;
    controller->interface_number = interface_number;
    controller->interface_open = interface_open;
    OpenClawUVCReadTerminal(interface, &controller->terminal_id, controls_out);
    *controller_out = controller;
    return 1;
}

int openclaw_uvc_control(
    OpenClawUVCController *controller,
    uint8_t selector,
    uint8_t request,
    void *data,
    uint16_t length,
    char **error_out
) {
    if (controller == NULL || controller->interface == NULL || data == NULL || length == 0) {
        OpenClawUVCSetError(error_out, "invalid control request");
        return 0;
    }

    IOUSBDevRequest control_request = {
        .bmRequestType = request == OpenClawUVCSetCurrent ? 0x21 : 0xa1,
        .bRequest = request,
        .wValue = (uint16_t)selector << 8,
        .wIndex = ((uint16_t)controller->terminal_id << 8) | controller->interface_number,
        .wLength = length,
        .pData = data,
        .wLenDone = 0,
    };
    IOReturn result = (*controller->interface)->ControlRequest(controller->interface, 0, &control_request);
    if (result != kIOReturnSuccess) {
        OpenClawUVCSetError(
            error_out,
            "control selector 0x%02x request 0x%02x: %s (0x%08x)",
            selector,
            request,
            mach_error_string(result),
            result
        );
        return 0;
    }
    if (control_request.wLenDone != length) {
        OpenClawUVCSetError(
            error_out,
            "control selector 0x%02x request 0x%02x transferred %u of %u bytes",
            selector,
            request,
            control_request.wLenDone,
            length
        );
        return 0;
    }
    return 1;
}

void openclaw_uvc_close(OpenClawUVCController *controller) {
    if (controller == NULL) {
        return;
    }
    if (controller->interface != NULL) {
        if (controller->interface_open) {
            (*controller->interface)->USBInterfaceClose(controller->interface);
        }
        (*controller->interface)->Release(controller->interface);
    }
    if (controller->device != NULL) {
        (*controller->device)->Release(controller->device);
    }
    free(controller);
}
