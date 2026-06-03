import sharp from "sharp";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(__dir, "../public");

const svg = readFileSync(resolve(publicDir, "krill-icon-primary.svg"));

await sharp(svg).resize(192, 192).png().toFile(resolve(publicDir, "krill-192.png"));
await sharp(svg).resize(512, 512).png().toFile(resolve(publicDir, "krill-512.png"));

console.log("wrote public/krill-192.png");
console.log("wrote public/krill-512.png");
