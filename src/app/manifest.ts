import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "krill",
    short_name: "krill",
    description: "Local-first task pipeline for Claude Code. No goal-setting, no integrations, no infra.",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#e95420",
    icons: [
      { src: "/krill-192.png", sizes: "192x192", type: "image/png" },
      { src: "/krill-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
