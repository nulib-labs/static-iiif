# Repository Guidelines

## Project Overview
This project generates static IIIF Image 3.0 API resources and IIIF Presentation 3.0 manifests for a collection of images. It supports two deployment paths that share a common UI (`/ui`):

**Local / GitHub Actions path** — A file watcher (`app/start.js`) monitors `source/image/` and invokes `app/local/image/index.js` to produce Level 0 IIIF static image tiles written directly to `output/image/`. No cloud storage or storage abstraction is involved; files go straight to the local filesystem.

**AWS path** — A SAM application (`app/aws/template.yml`) provisions a source S3 bucket and an output S3 bucket (`*-iiif`). An S3-triggered Lambda (`app/aws/lambdas/iiif-image/`) converts uploaded source images to pyramid TIFFs (Level 2) for use by `samvera/serverless-iiif` (to be added to this repo). Deployment config lives in `app/aws/samconfig.toml`.

Both paths will eventually consume a CSV of collection metadata to generate IIIF Presentation 3.0 manifests that reference the IIIF image URLs.

## Project Structure
```
app/
  local/
    image/        # Level 0 tile generator; writes to output/image/ directly
  aws/
    template.yml          # SAM template (AWS path)
    samconfig.toml        # SAM deployment config (gitignored — copy from samconfig.toml.example)
    samconfig.toml.example
    lambdas/
      iiif-image/ # Lambda: converts source images to pyramid TIFs (Level 2)
  start.js        # File watcher — entry point for local/GH Actions path
source/
  image/          # Drop master images here (TIFF, JPEG, PNG, WebP)
output/
  image/          # Generated Level 0 tiles and info.json files (local path)
ui/               # React/Vite frontend; works against local output or deployed AWS
```

> Note: `app/storage/` is a vestige of an earlier approach and is not used by `app/local/image/index.js`. Do not wire the local image pipeline through the storage abstraction.

## Build, Test, and Development Commands
- `npm install` — install root dependencies; run inside `ui/` and any Lambda subdirectory separately.
- `node app/local/image/index.js` — process a single image manually (reads `source/image/debois.tif` by default).
- `npm start` — start the file watcher; processes any images already in `source/image/` then watches for new ones.
- `IIIF_BASE_URL=https://example.com npm start` — set the base URL used in `info.json` `id` fields.
- `npm test` — placeholder; replace with your actual test runner as coverage is added.
- `cd app/aws && sam build --use-container && sam deploy` — build and deploy the AWS stack. Docker must be running; `--use-container` is required so SAM installs native dependencies (e.g. sharp) inside a Linux arm64 container matching the Lambda runtime. Requires `app/aws/samconfig.toml`.
- `cd ui && npm run dev` — start the Vite dev server for the frontend.

## Environment / Feature Flags
The UI and any shared code must determine which backend is active. Use an environment variable (e.g. `VITE_BACKEND=local|aws`) so Vite can expose it at build time. Local development defaults to `local`; CI/CD targeting AWS sets `aws` and provides the relevant bucket/endpoint config.

## Coding Style & Naming Conventions
Use CommonJS modules (`require`/`module.exports`) and 2-space indentation in all Node.js code under `app/`. The UI (`/ui`) uses ESM and JSX. Prefer descriptive, dashed directory names and camelCase identifiers. Strings default to double quotes; async work uses `async`/`await`.

## Testing Guidelines
Add tests alongside code under `app/**/__tests__/` with filenames ending in `.test.js`. Use Node's native runner (`node --test`); wire it into `npm test` once implemented. Keep fixtures small under `app/<module>/__fixtures__`. Any new tiling or presentation feature should include at least a smoke test and validation against a sample IIIF document.

## Commit & Pull Request Guidelines
Use Conventional Commits (`feat:`, `fix:`, `chore:`, etc.) from the start. Reference related GitHub issues in the PR body. Include manual verification steps (`npm test`, sample render) so reviewers can reproduce. Keep PRs focused; split unrelated work into separate branches.
