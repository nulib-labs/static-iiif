# Repository Guidelines

## Project Structure & Module Organization
The project is a lightweight Node.js package: `package.json` defines scripts and metadata, while all logic lives in `app/`. Use `app/image/` for IIIF tiling helpers (current entry point is `index.js`) and treat `app/presentation/` as the workspace for manifests or viewers. Keep supportive assets (sample manifests, templates) inside the relevant module folder, leave a short README for new directories, and store master assets or data drops under `source/` so static builds can read them predictably.

## Build, Test, and Development Commands
- `npm install` — install dependencies; rerun after updating `package.json`.
- `node app/image/index.js` — process the default sample in `source/image/debois.tif`; extend it to accept flags when you need new identifiers.
- `npm start` — run the source watcher that observes `source/*` and hands new files to `app/image/index.js`, ensuring fresh tiles and `info.json` documents land under the mirrored `output/*` tree.
- Set `STORAGE_DRIVER=s3` along with `S3_BUCKET`, `S3_PREFIX`, and `AWS_REGION` to stream tiles directly to S3 (default driver writes under `output/`).
- `npm test` — currently a placeholder; replace with your actual test runner command as you add coverage so CI/CD hooks remain consistent.
Stick with Node 18+ so the built-in test runner and modern syntax are available.

## Coding Style & Naming Conventions
Use CommonJS modules (`require`/`module.exports`) and 2-space indentation to match the existing source file. Prefer descriptive, dashed directory names (`image-ops`, `manifest-tools`) and camelCase identifiers inside code. Strings should default to double quotes, and asynchronous work should rely on `async`/`await`. Configure a formatter such as Prettier once adopted, and run `npx prettier --check "app/**/*.js"` before opening a pull request.

## Testing Guidelines
Add tests alongside the code under `app/**/__tests__/` with filenames ending in `.test.js`. Node's native runner (`node --test`) is sufficient; once implemented, wire it into `npm test`. Keep fixtures small (store them under `app/<module>/__fixtures__`) and document unusual assumptions. A pull request should not remove coverage without explaining the trade-off, and any new tiler or presentation feature should include at least a smoke test and validation against a sample IIIF manifest.

## Commit & Pull Request Guidelines
The repository has no prior history, so adopt Conventional Commits immediately (for example, `feat: add jp2 tiling pipeline`) to keep the log machine-readable. Reference related GitHub issues in the body, describe visible changes, and attach screenshots or manifest snippets when you modify presentation assets. Every PR must list manual verification steps (`npm test`, sample render) so reviewers can reproduce results quickly. Keep PRs focused; split unrelated work into separate branches for faster reviews.
