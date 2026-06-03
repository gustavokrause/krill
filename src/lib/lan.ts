import { networkInterfaces } from "node:os";

export function getLanUrls(port: number): string[] {
  const ifaces = networkInterfaces();
  const urls: string[] = [];
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] ?? []) {
      if (net.family === "IPv4" && !net.internal) {
        urls.push(`http://${net.address}:${port}`);
      }
    }
  }
  return urls;
}
