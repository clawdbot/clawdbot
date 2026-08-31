FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    ffmpeg \
    git \
    openssh-client \
    unzip \
    xz-utils \
    zstd \
  && rm -rf /var/lib/apt/lists/*
