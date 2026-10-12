# fgj — Logo usage

## 1. The logo
- **Idea:** three letters cut from the same heavy rounded block. Thin cuts on one shared line make each letter. The cut letters read as one word.
- **Colour:** monochrome only. Use black on light backgrounds. Use white on dark backgrounds.
- **Versions:**
  - Wordmark: `fgj-wordmark-black.svg`, `fgj-wordmark-white.svg`
  - Icon (word on a tile): `fgj-icon-dark.svg`, `fgj-icon-light.svg`, `fgj-icon-knockout-black.svg` (letters are holes)
  - Web: `web/` (favicon.ico, favicon.svg, PNG icons, `site.webmanifest`, `head-snippet.html`)

## 2. Clear space
Keep a clear zone of **half the letter height** on all sides of the wordmark. The zone scales with the logo.

## 3. Minimum size
| Version | Screen |
|---|---|
| Wordmark | 24 px letter height (about 75 px wide) |
| Icon | 32 px. At 16 px it is a texture, not text. |

## 4. Colour
| Name | HEX | RGB |
|---|---|---|
| Black | #000000 | 0 0 0 |
| White | #FFFFFF | 255 255 255 |

Approved pairs: black on white or light grey · white on black or dark grey · icon dark tile on any background.
For one-colour output (stamps, laser, embroidery), use `fgj-icon-knockout-black.svg`. The two-colour icon files become a solid block in one colour.

## 5. Construction (for redrawing or new letters)
- Glyph box 240 × 240, corner radius 96 (rounded square).
- Cut width 16. Upper cut line at 78–94. Stem edge at 96 (G, J) or 120 (F).
- F: slit from x 120, middle bar ends at x 200, bite from y 179.
- G: slit from x 96, tick 96–112 down to y 154.
- J: bite to x 112 and y 94, tick 96–112 down to y 154.
- Spacing: F–G 2, G–J 14 (glyph units).

## 6. Don'ts
- Do not stretch, rotate, or slant the logo.
- Do not add colour, gradients, outlines, or shadows.
- Do not change the spacing between the letters.
- Do not type "FGJ" in a font to make the logo. Use the files.
- Do not put the wordmark on a busy background. Use the icon tile there.

## 7. README use
Use the black wordmark in light themes and the white wordmark in dark themes. Use
`png/fgj-icon-dark-512.png` as the repository avatar.
