import AppKit
import Testing
@testable import OpenClaw

struct DashboardNavAccessoryTests {
    @Test func `parses and bounds nav state messages`() {
        #expect(DashboardNavStateMessage.parse([
            "type": "nav-state",
            "collapsed": true,
            "width": 280.5,
        ]) == DashboardNavStateMessage(collapsed: true, width: 280.5))
        #expect(DashboardNavStateMessage.parse([
            "type": "nav-state",
            "collapsed": false,
            "width": 5000,
        ]) == DashboardNavStateMessage(collapsed: false, width: 2000))
        #expect(DashboardNavStateMessage.parse([
            "type": "nav-state",
            "collapsed": false,
            "width": -10,
        ]) == DashboardNavStateMessage(collapsed: false, width: 0))
    }

    @Test func `rejects malformed nav state messages`() {
        #expect(DashboardNavStateMessage.parse([
            "type": "other",
            "collapsed": true,
            "width": 280,
        ]) == nil)
        #expect(DashboardNavStateMessage.parse([
            "type": "nav-state",
            "collapsed": true,
        ]) == nil)
        #expect(DashboardNavStateMessage.parse([
            "type": "nav-state",
            "collapsed": true,
            "width": Double.nan,
        ]) == nil)
        #expect(DashboardNavStateMessage.parse([
            "type": "nav-state",
            "collapsed": "yes",
            "width": 280,
        ]) == nil)
        #expect(DashboardNavStateMessage.parse([
            "type": "nav-state",
            "collapsed": 1,
            "width": 280,
        ]) == nil)
        #expect(DashboardNavStateMessage.parse([
            "type": "nav-state",
            "collapsed": true,
            "width": "280",
        ]) == nil)
    }

    @Test func `computes bounded accessory widths`() {
        #expect(DashboardNavAccessoryView.accessoryWidth(
            sidebarWidth: 280,
            originX: 78,
            windowWidth: 1000) == 190)
        #expect(DashboardNavAccessoryView.accessoryWidth(
            sidebarWidth: 100,
            originX: 78,
            windowWidth: 1000) == 116)
        #expect(DashboardNavAccessoryView.accessoryWidth(
            sidebarWidth: 500,
            originX: 78,
            windowWidth: 300) == 210)
    }
}
