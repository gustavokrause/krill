/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: [
    "better-sqlite3",
    "simple-git",
    "@kwsites/file-exists",
    "node-cron",
  ],
};

export default nextConfig;
