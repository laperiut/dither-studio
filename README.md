# Laser Dither Studio

A free, 100% offline image dithering tool for laser engraving. Runs entirely in your browser — **your images never leave your computer**.

**[▶ Use it in your browser](https://laperiut.github.io/dither-studio/)** &nbsp;·&nbsp; **[⬇ Download the single-file offline version](https://github.com/laperiut/dither-studio/releases/latest)** (save the file, double-click it, done — no install, no internet needed)

![Laser Dither Studio](https://img.shields.io/badge/100%25-offline-brightgreen) ![License](https://img.shields.io/badge/license-MIT-blue)

## What it does

Prepares photos for laser engraving the same way paid/online tools like imag-r do:

- **Material presets** — wood, black slate, black acrylic, leather, cork, glass, anodized aluminium, white tile (Norton method) — each with the right invert setting and a realistic on-material preview
- **12 dither algorithms** — Jarvis–Judice–Ninke, Stucki, Floyd–Steinberg, Atkinson, Burkes, Sierra (3 variants), Bayer 8×8 ordered, clustered-dot halftone, sketch, and plain threshold
- **Size & DPI control** — set output size in mm and DPI (254 / 282 / 423 / 508); the exported PNG has the DPI embedded, so LightBurn / xTool just needs image mode set to **Pass-through**
- **Adjustments** — brightness, contrast, gamma, unsharp mask sharpening
- **Crop** — rectangular or circle crop
- **Board / workpiece preview** — position the image on a board of your dimensions, drag to place
- **Engraved preview** — simulates how the dots blend together in the real burn
- **Customer mockups** — export a smooth "how it will look" JPG to send to customers

> imag-r's algorithm names (Norton, Kasia, Baning…) are proprietary presets built on the open algorithms above. Jarvis / Stucki give the smooth photographic look; "Norton" = white tile material + invert.

## Running it

**Easiest:** download [`dist/dither-studio-portable.html`](dist/dither-studio-portable.html) — a single self-contained file with everything embedded. Works from your desktop with no internet connection.

**From source:** clone the repo and open `dither-studio.html` in any modern browser.

**Rebuilding the portable file** after editing the source:

```
node build-portable.js
```

## Typical workflow

1. Open (or drag & drop / paste) a photo
2. Pick your material — invert and preview update automatically
3. Set the real-world size in mm and your machine's DPI
4. Tweak brightness / contrast / gamma / sharpening while watching the on-material preview
5. Choose a dither algorithm (Jarvis or Stucki for photos)
6. **Download PNG** → import into LightBurn / xTool with image mode **Pass-through**

## License

MIT — free to use, copy, modify, and share.
