import type { MetadataRoute } from "next";

/**
 * Web app manifest, for Android/desktop installs and for iOS to treat the
 * home-screen save as a web app (iOS only delivers push to installed web
 * apps). iOS takes its icon from apple-icon.png, not from here.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    // The install identity, pinned so changing start_url later doesn't read as
    // a different app and orphan existing installs.
    id: "/",
    name: "Powerflow",
    short_name: "Powerflow",
    description: "Real-time and historical energy monitoring for your home power panel.",
    start_url: "/",
    display: "standalone",
    // --color-bg; the manifest can't read the stylesheet.
    background_color: "#050608",
    theme_color: "#050608",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // Launchers crop maskable icons to their own shape, so this one is
      // full-bleed with the mark inside the safe zone.
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
