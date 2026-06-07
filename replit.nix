{pkgs}: {
  deps = [
    pkgs.xorg.libXft
    pkgs.xorg.libXrender
    pkgs.xorg.libXext
    pkgs.xorg.libX11
    pkgs.xvfb-run
    pkgs.python312Packages.tkinter
  ];
}
