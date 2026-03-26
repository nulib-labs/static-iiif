# IIIF_IMAGE_SKILL

## Purpose
Implement helper utilities under `app/image/*` that can precompute "level 0"-compliant IIIF Image API 3.0 tiles plus the mandatory `info.json`. The skill targets static hosting: every `{identifier}/{region}/{size}/{rotation}/{quality}.{format}` variant you expose must correspond to a real file on disk. Focus on the tiler for now: generate canonical pyramid tiles from a master asset living in `source/` and emit a descriptive info document for viewers.

## Required Inputs
- **Source asset metadata**: integer `width` and `height`, file path, format.
- **Tile configuration**: tile `width` (and optional `height`), array of integer `scaleFactors`, output directory root, supported `formats` (default `jpg`), `qualities` (at minimum `default`).
- **Service metadata**: public base URL, identifier string, declared limits (`maxWidth`, `maxHeight`, `maxArea` if any), compliance `profile` (use `level0`).

## Skill Responsibilities
1. **Canonical URI layout**: ensure generated directories follow `{identifier}/{region}/{size}/{rotation}/{quality}.{format}`. Tiles should request `region=x,y,w,h` where `w` and `h` equal `tileWidth * scaleFactor` (capped at image bounds). Always export rotation `0` and quality `default` for level 0.
2. **Tile math**: for each scale factor `s`, derive scaled image dimensions `ceil(width / s)` and `ceil(height / s)`. Slice into grids of `tileWidth × tileHeight` (default square) and crop edge tiles to remaining pixels instead of padding blank space.
3. **Output formats**: emit files using formats you declare. Level 0 needs only one format; if you add PNG/JPEG2000 you must list them in `extraFormats` and produce real assets.
4. **info.json construction**: include `@context`, `id`, `type`, `protocol`, `profile`, `width`, `height`. Add `tiles` array matching the generated tile config, optional limits (`maxWidth`, etc.), and `extra*` arrays for any declared features. Always expose `sizes` entries for each downscaled full image variant you generate.
5. **Validation**: before writing, assert requested tiles obey spec—no params below 1px and no sizes exceeding declared limits. Provide helper routines for URI encoding of identifiers, canonicalizing floats, and zero-padding coordinates if desired.
6. **Static hosting hints**: store tiles under `public/{identifier}/...` or similar (or push them to object storage via pluggable adapters) and include a `Link` header or manifest snippet if deploying via CDN. Document manual verification: spot-check `info.json`, open a tile URI, and ensure widths and heights reflect cropping rules.

Use IIIF_IMAGE_SKILL when scaffolding future modules inside `app/image/` so every helper maintains IIIF Image API 3.0 compliance from metadata through file layout.
