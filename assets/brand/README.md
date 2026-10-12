# brand

The fgj logo: a wordmark and an icon, in monochrome. [`USAGE.md`](USAGE.md) is the
logo guide: clear space, minimum sizes, colours, construction, and what not to do.

- [`fgj-wordmark-black.svg`](fgj-wordmark-black.svg) and
  [`fgj-wordmark-white.svg`](fgj-wordmark-white.svg): the wordmark for light and dark
  backgrounds.
- [`fgj-wordmark-auto.svg`](fgj-wordmark-auto.svg): the same wordmark. It is black, and
  white when the viewer's colour scheme is dark. The root README uses it, because
  Forgejo removes `<picture>` from Markdown. A render on Forgejo 16.0.5 checked it with
  the automatic theme only; another theme or browser can show the black version.
- [`fgj-icon-dark.svg`](fgj-icon-dark.svg), [`fgj-icon-light.svg`](fgj-icon-light.svg):
  the word on a tile. The dark tile works on any background.
- [`fgj-icon-knockout-black.svg`](fgj-icon-knockout-black.svg): the one-colour icon,
  with the letters cut out.

`USAGE.md` also names PNG and web favicon files. They stay in the logo kit, outside this
repository.

This directory does not own the repository avatar; a maintainer sets it in the
repository settings.
