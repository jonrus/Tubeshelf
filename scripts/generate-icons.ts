import sharp from "sharp";

const SOURCE = "public/icons/source.svg";
const OUT_DIR = "public/icons";

const sizes = [
  { file: "icon-16.png", size: 16 },
  { file: "icon-32.png", size: 32 },
  { file: "icon-180.png", size: 180 },
  { file: "icon-192.png", size: 192 },
  { file: "icon-512.png", size: 512 },
];

for (const { file, size } of sizes) {
  await sharp(SOURCE).resize(size, size).png().toFile(`${OUT_DIR}/${file}`);
  console.log(`wrote ${file} (${size}x${size})`);
}

// Maskable icon: pad the artwork into an ~80% safe zone on a solid background so OS
// icon masks (circle, squircle, etc.) don't clip it.
const padded = await sharp(SOURCE).resize(410, 410).png().toBuffer();
await sharp({
  create: { width: 512, height: 512, channels: 4, background: "#020617" },
})
  .composite([{ input: padded, left: 51, top: 51 }])
  .png()
  .toFile(`${OUT_DIR}/icon-512-maskable.png`);
console.log("wrote icon-512-maskable.png (512x512, 410x410 safe zone)");
