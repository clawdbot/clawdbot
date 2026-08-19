# Digest-pinned like the repo's other images: a moving tag would change the
# recorded desktop's OS bytes outside review.
FROM docker.io/library/ubuntu:24.04@sha256:d78ab76437b1afc5f01e223d6bf0172763f404bb166441328845adbef44518cb

ENV DEBIAN_FRONTEND=noninteractive

RUN set -eux; \
    telegram_desktop_version=7.0.9; \
    telegram_desktop_url=https://github.com/telegramdesktop/tdesktop/releases/download/v7.0.9/tsetup.7.0.9.tar.xz; \
    telegram_desktop_sha256=d3c05df0259ab116d11d8c1cdc1403019d2a3be303ad3b46d16a84e19df6615f; \
    test "$(dpkg --print-architecture)" = "amd64"; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      arc-theme \
      ca-certificates \
      curl \
      dbus-x11 \
      ffmpeg \
      fonts-dejavu-core \
      fonts-liberation \
      git \
      iproute2 \
      libopengl0 \
      libxcb-cursor0 \
      libxcb-icccm4 \
      libxcb-image0 \
      libxcb-keysyms1 \
      libxcb-randr0 \
      libxcb-render-util0 \
      libxcb-shape0 \
      libxcb-xfixes0 \
      libxcb-xinerama0 \
      libxkbcommon-x11-0 \
      netcat-openbsd \
      novnc \
      openssh-server \
      openssl \
      procps \
      python3 \
      rsync \
      scrot \
      sudo \
      websockify \
      wmctrl \
      x11-utils \
      x11-xserver-utils \
      x11vnc \
      xauth \
      xclip \
      xdotool \
      xfce4-panel \
      xfce4-session \
      xfce4-settings \
      xfce4-terminal \
      xfconf \
      xfdesktop4 \
      xfwm4 \
      xsel \
      xterm \
      xvfb \
      xz-utils \
      zbar-tools; \
    install_root="$(mktemp -d)"; \
    curl -fL --retry 5 --retry-all-errors -o "$install_root/telegram.tar.xz" "$telegram_desktop_url"; \
    printf '%s  %s\n' "$telegram_desktop_sha256" "$install_root/telegram.tar.xz" | sha256sum --check --status; \
    tar -xJf "$install_root/telegram.tar.xz" -C "$install_root"; \
    test -x "$install_root/Telegram/Telegram"; \
    install -d -o root -g root -m 0755 /opt/Telegram /var/lib/crabbox; \
    cp -a "$install_root/Telegram/." /opt/Telegram/; \
    chown -R root:root /opt/Telegram; \
    chmod 0755 /opt/Telegram /opt/Telegram/Telegram; \
    rm -f /opt/Telegram/Updater; \
    printf '%s\n' "$telegram_desktop_version" >/var/lib/crabbox/telegram-desktop-version; \
    chmod 0644 /var/lib/crabbox/telegram-desktop-version; \
    rm -rf "$install_root" /var/lib/apt/lists/*

# Fail the build if the base ever drops the account this image defaults to.
RUN getent passwd ubuntu >/dev/null

# Crabbox launches leases with an explicit --user root, so its bootstrap still runs
# privileged; this default only bounds a direct `docker run` of the image.
USER ubuntu
