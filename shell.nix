{ pkgs ? import <nixpkgs> {} }:

let
  nodejs = pkgs.nodejs_24;
in
pkgs.mkShell {
  name = "openclaw";

  nativeBuildInputs = [
    nodejs
    pkgs.pnpm
    pkgs.bun
    pkgs.python3
    pkgs.git
    pkgs.curl
    pkgs.openssl
    pkgs.pkg-config
    pkgs.vim
    pkgs.ripgrep
    pkgs.stdenv.cc
    pkgs.gnumake
    pkgs.cmake
    pkgs.sqlite
  ];

  buildInputs = [
    pkgs.vips
    pkgs.expat
    pkgs.libsecret
  ];

  shellHook = ''
    # Suppress corepack shim interference — pnpm comes from nixpkgs
    export COREPACK_ENABLE_SHIM=0
    echo "openclaw dev shell  node $(node -v)  pnpm $(pnpm -v)  bun $(bun --version)"
  '';
}
