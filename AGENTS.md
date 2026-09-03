# Repository Guidelines

## Project Overview
This project generates static IIIF Image 3.0 API resources and IIIF Presentation 3.0 manifests for a collection of images, deployed entirely on AWS. A SAM application (`app/aws/template.yml`) provisions a source S3 bucket and an output S3 bucket (`*-iiif`). An S3-triggered Lambda (`app/aws/lambdas/iiif-image/`) converts uploaded source images to pyramid TIFFs (Level 2) for use by `samvera/serverless-iiif` (a nested SAR application). A second Lambda (`app/aws/lambdas/manifest/`) exposes a CRUD API (behind API Gateway + Cognito auth) for managing IIIF Presentation 3.0 manifests. A third Lambda (`app/aws/lambdas/search/`) maintains a title search index for those manifests in an existing, shared AWS OpenSearch domain (not provisioned by this repo) — see "Search index" below. A React/Vite frontend (`ui/`) talks to all three, and is hosted via Amplify.

The project metadata CSV → manifest generation flow described in earlier iterations is still a future goal; today the manifest API supports single-manifest CRUD only.

## UI Structure
The dashboard (`ui/src/App.jsx`) is organized into tabs:
- **Works** — create/manage IIIF Presentation manifests (the `presentation/manifest/` prefix in the IIIF bucket) and preview the selected manifest via Clover Viewer.
- **Assets** — browse and upload files in the `image/` prefix of the **source** bucket (not the IIIF/output bucket) via the Amplify Storage Browser. Uploading here is what feeds the `iiif-image` Lambda's pipeline. The Cognito authenticated role's IAM policy scopes `s3:PutObject`/`s3:GetObject` to `image/*` only — the bucket root is intentionally not writable (or listable) from the UI.

Future: a third tab/prefix for audio/video assets (A/V) is anticipated but out of scope for now — don't build it until it's explicitly requested.

## Search index
The **Works** tab also has a "Publish search index" button and a search box. Clicking
Publish calls `POST /search/reindex`, which (idempotently) creates the OpenSearch index/mappings
if missing, then does a full reindex from the manifests in S3 (the source of truth) — bulk
upserting a document per manifest and deleting any indexed documents for manifests no longer
in S3. There's no separate "enable" step and no enabled/disabled state stored anywhere: every
stack with `OpenSearchEndpoint` configured behaves the same way. Documents are intentionally
minimal — `title` (searchable), `manifestId` (the manifest's own id/URL), and `id` (a base64url
encoding of `manifestId`, used as the OpenSearch `_id`) — with no routes/href/thumbnail fields,
so the index doesn't bake in this app's own routing assumptions (a IIIF front-end like
`canopy-iiif` can build its own id → route mapping separately). This app's own search box
derives its `/works/{identifier}` links locally by parsing `manifestId`.

The OpenSearch domain is pre-existing and shared (not provisioned by this repo, for cost
reasons — each collection stack gets its own index name on the one domain, not its own
domain). After a stack deploy with `OpenSearchDomainName`/`OpenSearchEndpoint` set, read the
`SearchFunctionRoleArn` stack output and add it to that domain's access policy yourself
(OpenSearch domain access is controlled by the domain's own resource-based policy, which this
repo's CloudFormation doesn't own).

## Project Structure
```
app/
  aws/
    template.yml          # SAM template — all infra (S3, Cognito, API Gateway, Lambdas, Amplify Hosting)
    samconfig.toml         # Your personal SAM deployment config (gitignored — copy from samconfig.toml.example)
    samconfig.toml.example
    lambdas/
      iiif-image/          # Lambda: converts source images to pyramid TIFFs (Level 2)
      manifest/            # Lambda: manifest CRUD API
      search/              # Lambda: OpenSearch index management (reindex) + title query
  shared/
    manifest.js            # Manifest key/template/listing helpers shared by the manifest and search Lambdas
    search.js              # Search document shape + manifest-id encoding, shared by the search Lambda
ui/                        # React/Vite frontend — talks to the deployed AWS stack
  .env.local               # Your personal env config (gitignored — copy from .env.local.example)
  .env.local.example
```

> Note: `app/storage/`, if present, is a vestige of an earlier approach and is not used by any current Lambda.

## Build, Test, and Development Commands
- `npm install` — install root dependencies; run inside `ui/` and any Lambda subdirectory separately.
- `npm test` — placeholder; replace with your actual test runner as coverage is added.
- `cd app/aws && sam build --use-container && sam deploy --guided` — one-time build and deploy of your personal dev stack. Docker must be running; `--use-container` is required so SAM installs native dependencies (e.g. sharp) inside a Linux arm64 container matching the Lambda runtime. Requires `app/aws/samconfig.toml` (see Local Development below).
- `cd app/aws && sam sync --watch` — fast iterative redeploys of Lambda code changes to your personal stack (see Local Development).

> **Never run a bare `sam build` as a substitute when Docker is down.** It builds *every*
> function, and `iiif-image` bundles `sharp`'s platform-specific native binary. Off a Mac
> you get `@img/sharp-darwin-arm64` instead of `linux-arm64`, the build and deploy both
> report success, and the converter then dies on cold start with
> `Could not load the "sharp" module using the linux-arm64 runtime`. Nothing surfaces in
> the UI except imports that stall on "Converting image…", because the pyramid TIFF never
> appears. Start Docker and rebuild with `--use-container` instead. To confirm a build is
> sound: `ls app/aws/.aws-sam/build/IIIFImageFunction/node_modules/@img/` should list
> `sharp-linux-arm64` and no `darwin` entries.
- `cd ui && npm run dev` — start the Vite dev server for the frontend, pointed at your personal stack's endpoints via `ui/.env.local`.

## Local Development

Every developer deploys and works against their **own personal SAM stack** rather than a shared one — there is no local emulation of Cognito/S3/API Gateway. "Local" means: the UI dev server runs on your machine, talking to real AWS resources.

### Prerequisites
- Docker running (needed for `sam build --use-container`).
- Node/npm installed.
- An AWS SSO profile with access to the target account (ask a teammate which profile/account this project deploys to if you don't know — check `~/.aws/config` for candidates). This repo has been deployed under an `AWSAdministratorAccess`-type profile.

### 1. Authenticate to AWS
```
export AWS_PROFILE=<your-profile>   # e.g. staging-admin
aws sso login
aws sts get-caller-identity         # sanity check — should return your account/role, not an error
```
SSO sessions expire; re-run `aws sso login` whenever `sam`/`aws` commands start failing with `ExpiredToken`/`ExpiredTokenException`.

### 2. Stand up (or update) your personal stack
1. Copy `app/aws/samconfig.toml.example` to `app/aws/samconfig.toml` (gitignored) and set `stack_name` to something unique to you, e.g. `<yourname>-dev-static-iiif`.
2. First time only:
   ```
   cd app/aws
   sam build --use-container
   sam deploy --guided
   ```
   `--use-container` is required so SAM installs native dependencies (e.g. sharp) inside a Linux arm64 container matching the Lambda runtime. Answer the guided prompts once; SAM remembers them in `samconfig.toml` for next time.
3. On later changes: `sam build --use-container && sam deploy` (drop `--guided`). Add `--no-confirm-changeset` to skip the interactive `y/N` prompt if you've already reviewed the changeset shape.
4. For fast iteration on Lambda code without a full deploy, use `sam sync --watch` (or `sam sync --code` for a one-shot sync) instead.
   - **Caveat:** `IiifServer`, the nested `AWS::Serverless::Application` wrapping `samvera/serverless-iiif`, does not hot-sync via `sam sync --watch` the way the top-level `ManifestFunction`/`IIIFImageFunction` do. Changes affecting it need a full `sam deploy`. This is a third-party component that rarely changes, so it's a minor caveat in practice.

### 3. Create `ui/.env.local` from your stack's outputs
Fetch your stack's outputs:
```
aws cloudformation describe-stacks --stack-name <your-stack-name> --query 'Stacks[0].Outputs'
```
Copy `ui/.env.local.example` to `ui/.env.local` (gitignored) and fill it in from the output values — the mapping from CloudFormation output key to `VITE_*` variable is documented in the example file itself (`IiifEndpoint` → `VITE_IIIF_BASE_URL`, `ManifestApiUrl` → `VITE_MANIFEST_API_URL` with `/manifests` appended, `IIIFBucketName` → `VITE_STORAGE_BUCKET`, `SourceBucketName` → `VITE_SOURCE_BUCKET`, etc).

### 4. Run the UI and sign in
```
cd ui
npm run dev
```
Open `http://localhost:5173`. You'll land on the Cognito `Authenticator` sign-in screen — this is expected, the whole app is behind auth now. If you don't have a user in your stack's Cognito pool yet, create one (the pool uses email as the username):
```
aws cognito-idp admin-create-user \
  --user-pool-id <VITE_COGNITO_USER_POOL_ID> \
  --username <your-email> \
  --user-attributes Name=email,Value=<your-email> Name=email_verified,Value=true \
  --message-action SUPPRESS

aws cognito-idp admin-set-user-password \
  --user-pool-id <VITE_COGNITO_USER_POOL_ID> \
  --username <your-email> \
  --password '<a-password-meeting-the-pool-policy>' \
  --permanent
```
(If `admin-create-user` says the user already exists, just run the `admin-set-user-password` step to reset it.) Sign in, and you should see the dashboard: the **Works** tab with the Presentation Manifests panel (talking to the real manifest API) and Clover Viewer preview, and the **Assets** tab with the S3 Storage Browser listing your stack's source bucket (`image/` prefix, upload-enabled).

## Environment / Feature Flags

### UI (`ui/`)
| Variable | Description |
|---|---|
| `VITE_IIIF_BASE_URL` | e.g. `https://abc.cloudfront.net/iiif/2` — serverless-iiif endpoint; pre-populates the URL input. Copy from the `IiifServer` nested stack's endpoint output after `sam deploy`. |
| `VITE_MANIFEST_API_URL` | The `ManifestHttpApi` endpoint from stack outputs. |
| `VITE_SEARCH_API_URL` | The `ManifestHttpApi` endpoint's `/search` path. Empty (search UI hidden) unless the stack was deployed with `OpenSearchEndpoint` set. |
| `VITE_STORAGE_BUCKET` / `VITE_STORAGE_REGION` | The IIIF output S3 bucket and its region. `STORAGE_BUCKET` also configures Amplify's default `Storage.S3` bucket (used for Auth/Storage bootstrap). |
| `VITE_SOURCE_BUCKET` | The source S3 bucket (uploads land here, under `image/`, and trigger the `iiif-image` Lambda). Used by the Assets tab's Storage Browser location. |
| `VITE_STORAGE_IDENTITY_POOL_ID` / `VITE_COGNITO_USER_POOL_ID` / `VITE_COGNITO_CLIENT_ID` | Cognito identifiers from stack outputs, for the Amplify `Authenticator`. |

### Amplify deployment
Connect the repo in Amplify (this is Amplify **Hosting** only — auth/storage/API are all defined via SAM, not the Amplify backend framework). The inline `BuildSpec` in `template.yml`'s `AmplifyApp` resource handles the build (`ui/` subdirectory, outputs `ui/dist`) and injects the `VITE_*` environment variables from the stack's own resources automatically.

## Coding Style & Naming Conventions
Use CommonJS modules (`require`/`module.exports`) and 2-space indentation in all Node.js code under `app/`. The UI (`/ui`) uses ESM and JSX. Prefer descriptive, dashed directory names and camelCase identifiers. Strings default to double quotes; async work uses `async`/`await`.

## Design Conventions

The UI is built on Radix Themes (`accentColor="iris"`, `grayColor="mauve"`, `scaling="110%"` in `ui/src/main.jsx`). Reach for a Radix component before hand-rolling one, and use theme tokens (`--gray-N`, `--accent-N`, `--space-N`, `--radius-N`) rather than literal colors or pixel values. Never hardcode a hex — it will not follow the theme.

**Interactive surfaces.** Any surface a user grabs, drops onto, or otherwise manipulates directly — drag handles, dropzones, and similar affordances — uses a muted gray at rest and a muted accent on hover. Use the shared tokens from `ui/src/App.css` rather than repeating the scale steps:

```css
background-color: var(--interactive-surface);        /* --gray-3   */
color: var(--interactive-surface-text);              /* --gray-11  */

/* on hover */
background-color: var(--interactive-surface-hover);  /* --accent-3 */
color: var(--interactive-surface-text-hover);        /* --accent-11 */
```

Pair them with `transition: background-color 0.15s ease, color 0.15s ease`. A surface that also has an *active* state (mid-drag, for example) should read one step stronger than hover — `--accent-4` — so the live target is unmistakable. Current examples: `.canvas-drag-handle` in `ui/src/App.css` and `.asset-dropzone` in `ui/src/components/AssetDropzone.css`.

The same gray-to-accent idea applies to **editable text** (`.canvas-label-editable`), which has no resting background and only lights up on hover. Use the *alpha* step `--accent-a3` there rather than the solid `--accent-3`: that highlight sits over cards, table rows and the page background, so it has to blend with whatever is behind it.

**Metadata field spacing.** Field groups in the Metadata and Layout panels — Description, Additional fields, Display — are separated by **2rem**, via the shared `.metadata-fields` class in `ui/src/App.css`. Add new fields as children of that container rather than giving them a `gap` prop of their own, and the spacing comes for free. The fields are visually distinct blocks with their own small label-to-control spacing (`mb="1"`), so they need noticeably more room between groups than a default Radix gap provides.

The tokens are declared on `:root, .radix-themes` together. Radix redeclares its scales on `.radix-themes`, so a token defined only on `:root` resolves against the bare document and silently misses the active theme's gray/accent — the same trap that applies to the font-family overrides above it.

## Testing Guidelines
Add tests alongside code under `app/**/__tests__/` with filenames ending in `.test.js`. Use Node's native runner (`node --test`); wire it into `npm test` once implemented. Keep fixtures small under `app/<module>/__fixtures__`. Any new tiling or presentation feature should include at least a smoke test and validation against a sample IIIF document.

## Commit & Pull Request Guidelines
Use Conventional Commits (`feat:`, `fix:`, `chore:`, etc.) from the start. Reference related GitHub issues in the PR body. Include manual verification steps (`npm test`, sample render) so reviewers can reproduce. Keep PRs focused; split unrelated work into separate branches.
