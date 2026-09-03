#!/usr/bin/env python3

import argparse

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="OpenClaw Linux X11 computer-use fixture")
    parser.add_argument("--title", required=True)
    parser.add_argument("--text", required=True)
    args = parser.parse_args()

    window = Gtk.Window(title=args.title)
    window.set_default_size(520, 180)
    window.connect("destroy", Gtk.main_quit)

    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
    box.set_border_width(24)
    label = Gtk.Label(label="Background-edit target")
    label.set_xalign(0)
    entry = Gtk.Entry()
    entry.set_name("Editor")
    entry.set_text(args.text)
    entry.set_activates_default(False)

    box.pack_start(label, False, False, 0)
    box.pack_start(entry, False, False, 0)
    window.add(box)
    window.show_all()
    Gtk.main()


if __name__ == "__main__":
    main()
