import type { NextConfig } from "next";

const config: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "sharp", "@tus/server", "@tus/file-store"],
  poweredByHeader: false,
};

export default config;
