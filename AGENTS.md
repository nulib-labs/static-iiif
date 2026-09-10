# Repository Guidelines

## Project Overview
This project is the admin backend for one or more downstream IIIF sites (Canopy or similar), deployed entirely on AWS. **A collection is the unit of everything**: each downstream site is driven by one curatorial collection, consuming that collection's IIIF documents and its own search index.

A SAM application (`app/aws/template.yml`) provisions a source S3 bucket and an output S3 bucket (`*-iiif`). An S3-triggered Lambda (`app/aws/lambdas/iiif-image/`) converts uploaded source images to pyramid TIFFs (Level 2) for use by `samvera/serverless-iiif` (a nested SAR application). `app/aws/lambdas/manifest/` exposes the whole CRUD and query API behind API Gateway + Cognito. `app/aws/lambdas/publish/` is the task worker for the publish state machine. A React/Vite frontend (`ui/`) talks to them, hosted via Amplify.

### The two spaces

The IIIF bucket holds two parallel, self-consistent IIIF spaces. A document under `working/` links only to other `working/` documents, and the same for `published/`:

```
working/presentation/manifest/{workId}/manifest.json
working/presentation/collection/{slug}/collection.json
working/presentation/collection/index/collection.json     ← root register
working/showcase.json                                      ← pre-auth sign-in sample
published/presentation/…                                   ← the same shapes, published URLs
internal/import-status/{workId}.json                       ← operational, not public
internal/publish/{slug}/status.json
internal/publish/{slug}/{runId}/{plan,batches/N}.json
image/{workId}/{n}.tif                                     ← never duplicated by publishing
```

Because each space describes its own URLs, **publishing is a URL-rewriting transform, not a copy** (`app/shared/publish.js`). Both the draft and the published twin are retrievable at their own `id`. The cost is that S3 ETags are useless for "has this changed?", which is why content hashes are computed and recorded explicitly.

`IIIFBucketPolicy` grants anonymous `s3:GetObject` on `working/*` and `published/*` only. **Drafts stay world-readable on purpose** — Clover fetches manifests anonymously, and "published" means "in the consuming site's feed", not "visible". `internal/*` is excluded, and `image/*` need not be public because serverless-iiif reads the TIFFs through its own role.

The key and id builders take a `space` that defaults to `working` (`app/shared/space.js`), so every caller but the publish pipeline is correct without passing one. An unknown space throws rather than building a key nobody serves.

### One collection per work

A work belongs to **exactly one** collection, recorded in its `partOf`. There is no uncollected state: creating a work names a collection, and changing it is an explicit Move. This is what makes per-collection publishing well defined — with a work in several collections, "publish this collection" has no single answer for a shared manifest.

## UI Structure

Routes are declared in `ui/src/main.jsx`. Everything signed-in renders through a
**layout route**, `AppShell` (`ui/src/components/AppShell.jsx`), which owns the
purple Northwestern bar, the page container, and the band carrying the
"Understory" wordmark and the section switcher. Section components render into
its `<Outlet />` and must not draw chrome of their own.

The purple bar carries the Northwestern mark on the left and the session strip
on the right — `Signed in as <email> | Sign out`, with sign-out as an underlined
link rather than a button, because it is site chrome and should not compete with
the page's own controls. The email comes from the ID token's `email` claim
(`AuthGate`): the pool sets `UsernameAttributes: [email]`, so Cognito's own
`username` is an opaque UUID, and `signInDetails.loginId` does not survive a
reload on a cached session.

| Route | Component | State |
|---|---|---|
| `/` | `CollectionsPage` (`ui/src/pages/`) | Built — the home page |
| `/collections` | redirect to `/` | for older links |
| `/collection/:slug` | `CollectionWorksPage` | Built — index-backed list, filter, publish panel |
| `/collection/:slug/work/:workId` | `WorkPage` | Built |
| `/users` | `UsersPage` | Built — admin only |

Anything else redirects to `/`.

There is deliberately **no all-works view**: a work belongs to exactly one
collection, so the collections list is where you start and a work is always
reached through its collection.

- **Collections** (`/`) — the home page. Lists the root collection's members;
  admins can add and delete (delete only when empty). A collection's name links
  through to its works. Renaming is impossible by construction — the slug is the
  identity. See the Collections section below.
- **A collection's works** (`/collection/:slug`) — create/manage the IIIF
  Presentation manifests in one collection (the `working/presentation/manifest/` prefix
  in the IIIF bucket). The page heading is the collection's title.
- **A work** (`/collection/:slug/work/:workId`) — edit one work and preview it
  via Clover Viewer. Assets are uploaded per-work through `AssetDropzone`, which
  writes to the `image/` prefix of the **source** bucket (not the IIIF/output
  bucket) — that upload is what feeds the `iiif-image` Lambda's pipeline. The
  Cognito authenticated role's IAM policy scopes `s3:PutObject`/`s3:GetObject`
  to `image/*` only; the bucket root is intentionally not writable (or listable)
  from the UI.
- **Users** (`/users`) — lists the Cognito user pool and assigns roles and
  collection grants. Admin-only, hidden from the section menu for everyone else.
  See "Roles and permissions" below.

Sections are horizontal links on the wordmark line. With two destinations, a
dropdown cost a click and said less than simply showing them. The active
underline is painted transparent on every link so becoming active never changes
a link's height.

They are plain `Link`s, not `NavLink`s, and each `SECTIONS` entry carries its own
`match(pathname)`. NavLink's built-in matching cannot express what the
collections tab needs: without `end`, `to="/"` is a prefix of every path and
lights on `/users`; with `end`, it goes dark on `/collection/:slug`. Because the
matching is ours, `aria-current` is set by hand too — NavLink would derive it
from the matching being replaced, and marking the wrong tab is worse than not
marking one.

Adding a section means one entry in `SECTIONS`, its `match`, and one `<Route>`.

`ui/src/lib/api.js` holds the Amplify configuration, the deployed endpoint bases,
`apiFetch` and `manifestApiUrl`. Importing it is what configures Amplify, so
every `apiFetch` caller is configured by construction.

Future: a prefix for audio/video assets (A/V) is anticipated but out of scope for
now — don't build it until it's explicitly requested.

## Search index

One WORKING index per stack, holding every collection and filtered by a `collection` term. Published indexes are per collection, per publish run, behind a stable alias a downstream site points at. Names are built in `app/shared/search.js`:

```
{prefix}._working              the admin UI reads this
{prefix}.{slug}._pub.{runId}   one run's frozen output
{prefix}.{slug}                alias -> whichever pub index is live
{prefix}.{slug}._staged        alias -> a candidate awaiting its flip
```

Working is **one** index, not one per collection, because the OpenSearch domain is pre-existing and shared by every developer's personal stack. Fifteen collections × three indexes × two shards is ~75 shards per stack, against AWS guidance of 20–25 per GiB of JVM heap — and since OpenSearch 2.17 `cluster.max_shards_per_node` is fixed and cannot be raised. Published stays per collection because that is what makes an alias flip atomic for one collection without touching another's.

Two naming rules, both of which a test exists for:

- **Reserved segments start with `_`, and segment counts differ.** Without that, `{prefix}.working` is both the working index *and* the live alias of a collection someone named "Working".
- **`.` separates the parts, not `-`.** A slug is `[a-z0-9-]+`, so with a hyphen the staged alias of `my-coll` and the live alias of `my-coll-staged` are the same string.

**The working index is maintained write-through.** Every create, save, move and delete updates exactly one document in the same request that writes S3 — `app/aws/lambdas/manifest/store.js` is the single manifest writer and owns both. A full rebuild is no longer the everyday action; it is `POST /collections/reindex`, a rare repair that rebuilds the collection documents and the index from one pass over the corpus. The index holds no state S3 does not determine, which is what makes that possible and what stops it ever being the authority.

The import walk passes `skipIndex`: it rewrites the manifest once per canvas, and a 271-canvas import would otherwise be 271 index writes. It indexes once at the start (with `importing: true`) and once at the end.

Writes ask to become searchable before returning (`?refresh=wait_for`).
OpenSearch is near-real-time: a write is durable at once but invisible to
search until the next refresh, 1s by default. Every write here is followed
almost immediately by a read that has to see it — the works list after a save,
the sync counts the moment a publish run reports itself finished — and without
this the UI shows stale rows and stale counts until something re-queries a
second later, which reads as "the button did nothing". The exception is the
publish run's writes into its candidate index: nothing reads that until the
alias flip, so waiting there would only slow the run.

Bulk writes use `update` + `doc_as_upsert`, never `index`. `index` replaces the whole document, so a save racing the publish run's sync-state write would clobber it rather than merge.

Two document shapes, deliberately different. The working document carries `workId`, `collection`, `contentHash`, `syncState` and `importing`; the **published** document carries only `manifestId`, `title`, `thumbnails` and `itemCount` — nothing about how this app works. `thumbnails` is the one addition over the old shape, because a site rendering a result list otherwise has to fetch every manifest to draw it.

The domain is not provisioned by this repo. After a deploy, read the `OpenSearchAccessRoleArn` stack output and add it to that domain's access policy yourself — the domain's resource-based policy is not owned by this template. It is one ARN: `PublishFunction` shares `ManifestFunction`'s role precisely so it stays one.

> If the shared domain has **fine-grained access control** enabled, an IAM resource-policy grant is not sufficient — the role must also be mapped as a backend role in the security plugin, and `indices:admin/aliases` is a cluster-level permission there. Not verified against this deployment.

## Publishing

Two deliberate user actions, and the order is the point:

1. **Publish IIIF assets** runs `PublishStateMachine`. It rewrites every member of the collection into `published/` **and** builds the candidate search index from exactly the bytes it wrote, pointing `{prefix}.{slug}._staged` at it.
2. The curator rebuilds their static site from the published assets.
3. **Publish search index** is then a single atomic multi-action `_aliases` call.

The candidate is built in step 1 on purpose. Building it at flip time would index whatever the working index held by then — including edits made during step 2 — which re-opens exactly the drift the two steps exist to close.

The pipeline is an **inline Map**, not a Distributed Map: `Plan` writes the work list to S3 and emits only batch indices, so the state payload stays kilobytes against the 256KB limit. That avoids `ItemReader` IAM, the `ResultWriter` payload trap, and the circular dependency a Distributed Map creates by needing `states:StartExecution` on itself. Progress is a count of batch result objects in S3 — each batch owns a distinct key, so nothing contends and a page reload picks the run back up.

Load-bearing, not incidental:

- **`WriteCollection` is built from what the batches actually did, never from the plan.** A work whose write failed is simply absent, so a published collection can never advertise a manifest that 404s. Leaf before root, mirroring `applyReconciliation`.
- **Each published member carries `staticiiif:contentHash`** — the hash of the working bytes it was made from. That is the record of what is live, and it is why a work edited mid-run correctly shows as changed again afterwards. **The run therefore needs no lock**, and edits are not blocked while it runs.
- A diff journal written on every save was considered and rejected: a journal drifts the moment a write half-fails or a run dies, and nothing repairs it. Comparing durable artifacts cannot drift.
- The candidate index is created with a must-fail-if-exists PUT, so two runs starting in the same instant cannot both believe they own it.
- **Garbage collection only ever deletes the index that just stopped being live**, at flip time, and never one carrying an alias — so a concurrent run's candidate is safe and a flip is safe to retry.
- A conditional S3 write on `internal/publish/{slug}/status.json` is the run mutex.
- Alias state is read through `/_alias`, never `/_cat/indices`: the latter is a cluster-monitor API a scoped resource policy can deny.

**Publishing never re-copies images.** A pyramid TIFF is the same object for a draft and a live work, and the Image API is one endpoint. Publishing moves presentation JSON only.

## Project Structure
```
app/
  aws/
    template.yml          # SAM template — all infra (S3, Cognito, API Gateway, Lambdas, Amplify Hosting)
    samconfig.toml         # Your personal SAM deployment config (gitignored — copy from samconfig.toml.example)
    samconfig.toml.example
    lambdas/
      iiif-image/          # Lambda: converts source images to pyramid TIFFs (Level 2)
      manifest/            # Lambda: the whole API — works, collections, users, publish routes
        store.js           #   the ONE manifest writer: S3 PUT + working-index upsert together
        workIndex.js       #   the working index: write-through, works list, sync counts
        publishRoutes.js   #   start a run, read its progress, flip the alias
      publish/             # Lambda: PublishStateMachine's task worker
  shared/                  # SDK-free unless noted; see Testing Guidelines
    space.js               # working/published spaces and their key + URL prefixes
    collection.js          # IIIF Collection documents, slugs, partOf, reconciliation
    publish.js             # the URL-rewriting transform, content hashes, the run plan
    search.js              # index/alias names and the two document shapes
    access.js              # every authorization decision
    language.js            # IIIF language maps
    manifest.js            # manifest keys/templates/listing — loads the SDK
    opensearch.js          # signed HTTP to the domain — loads the SDK
ui/                        # React/Vite frontend — talks to the deployed AWS stack
  .env.local               # Your personal env config (gitignored — copy from .env.local.example)
  .env.local.example
```

> Note: `app/storage/`, if present, is a vestige of an earlier approach and is not used by any current Lambda.

## Cutover — read before deploying this over an existing stack

The working/published split changes every S3 key and every manifest `id` URL,
and the search index changed name and shape. **Nothing migrates.** A stack that
had content before needs it wiped and re-created:

```bash
STACK=<your-stack-name>

# 1. The old flat presentation tree. Buckets are DeletionPolicy: Retain, so
#    deleting the stack would NOT do this.
aws s3 rm "s3://${STACK}-iiif/presentation/" --recursive

# 2. The old global index (the new names are ${STACK}._working and friends).
#    Signed request, or do it from the OpenSearch console.
#    DELETE /${STACK}-works

# 3. Deploy, then paste the new role ARN into the domain's access policy.
cd app/aws && sam build --use-container && sam deploy
aws cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='OpenSearchAccessRoleArn'].OutputValue" --output text
```

Then recreate collections on `/` and re-import works. Images under `image/` in
both buckets are untouched by the key change, but a work re-imported from a
source manifest will fetch them again.

Parameters that changed: `SearchIndexName` is gone, replaced by
`SearchIndexPrefix` (defaults to the stack name, must be lowercase).
`OpenSearchEndpoint` and `OpenSearchDomainName` are now **required** — the works
list is served by the index, so a stack without one cannot list anything.

`ui/.env.local` loses `VITE_SEARCH_API_URL`.

> **This refactor has not yet been run against a live stack.** It is verified by
> 78 unit tests, esbuild resolving both Lambda graphs, `sam validate --lint`, and
> the UI building and serving every route — none of which exercises S3,
> OpenSearch or Step Functions. Treat the first deploy as the real test, and
> expect to find things. The end-to-end checklist in the plan file
> (`~/.claude/plans/`, §8) is written for exactly that pass.

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
| `VITE_COLLECTION_API_URL` | The `ManifestHttpApi` endpoint's `/collections` path. Needed as its own variable because `VITE_MANIFEST_API_URL` already ends in `/manifests`; the UI derives a fallback from it, but set this explicitly. **Every `VITE_*` must also be added to the `define` block in `ui/vite.config.js`** — Amplify injects them as process env vars, which Vite's own `.env` handling never sees, so a missing entry is `undefined` in production and fine in dev. |
| `VITE_STORAGE_BUCKET` / `VITE_STORAGE_REGION` | The IIIF output S3 bucket and its region. `STORAGE_BUCKET` also configures Amplify's default `Storage.S3` bucket (used for Auth/Storage bootstrap). |
| `VITE_SOURCE_BUCKET` | The source S3 bucket (uploads land here, under `image/`, and trigger the `iiif-image` Lambda). Used by `AssetDropzone`. |
| `VITE_STORAGE_IDENTITY_POOL_ID` / `VITE_COGNITO_USER_POOL_ID` / `VITE_COGNITO_CLIENT_ID` | Cognito identifiers from stack outputs, for the Amplify `Authenticator`. |

### Amplify deployment
Connect the repo in Amplify (this is Amplify **Hosting** only — auth/storage/API are all defined via SAM, not the Amplify backend framework). The inline `BuildSpec` in `template.yml`'s `AmplifyApp` resource handles the build (`ui/` subdirectory, outputs `ui/dist`) and injects the `VITE_*` environment variables from the stack's own resources automatically.

## Naming

The app is called **Understory** in the UI. The repo, the AWS stack, bucket
names and S3 prefixes are all still `static-iiif` — that rename has not been
done, so don't "fix" the mismatch in infrastructure without being asked.

## Sign-in showcase

The sign-in screen renders before anyone is authenticated, and every HttpApi
route sits behind `DefaultAuthorizer: CognitoAuthorizer` — so it cannot call the
API at all. It reads `presentation/showcase.json`, a small public object the
backend writes into the already-public IIIF bucket (which already allows
cross-origin GET), and picks five of the pool at random per visit.

Deliberately a static object rather than an unauthenticated `/showcase` route:
it keeps every API route behind Cognito, and bounds what an anonymous visitor
can see to a fixed sample instead of handing them a way to enumerate the corpus.
The images themselves are already publicly served by the Image API, but note
that the file does expose a sample of work identifiers to anyone who loads the
sign-in page — that is inherent to showing real works there.

It lives at `working/showcase.json` — inside a space, because the bucket policy
only serves those two prefixes anonymously and this file is read before anyone
can call the API. It is refreshed by `POST /collections/reindex`
(`refreshShowcase`), which has already paid for the corpus read, using
read-compare-write so an unchanged corpus writes nothing. It used to ride on
`GET /manifests`, which no longer exists. Tiles are requested as
`square/400,400` so every one is an identical square regardless of the source
aspect ratio — `square` region with an explicit `w,h` size is level-2 Image API
and reads the same in both 2.x and 3.x, so no version branching is needed.

## Asset list performance

A work can have hundreds of canvases (one here has 271), and the asset list is a
dnd-kit sortable. Three things keep dragging usable, and it is worth knowing
which problem each one solves — they are not interchangeable:

**Only `CANVAS_WINDOW_STEP` (40) cards are mounted at a time**, extended as a
sentinel below the list scrolls into view. This is the one that matters for drag
lag: dnd-kit measures the rect of *every mounted sortable* when a drag starts,
and that cost is linear in the count — measured at roughly 1.9ms each, so 271
cards stalled the first frame of a drag for over half a second (2 cards: 42ms,
271 cards: 540ms, 40 cards: ~200ms). **The trade-off is deliberate: you can only
reorder among rendered cards.** `handleDragEnd` looks indices up in the full
`canvasIds`, and the window is a prefix slice, so indices stay absolute and
correct. The observer is attached with a *callback ref*, not `useEffect` —
`ManifestDetail` returns early while a work loads, so a mount effect finds no
sentinel and never runs again. It also re-observes after each reveal, or a
sentinel that stays on screen never reports a new intersection and the list
stops growing.

**`content-visibility: auto` with `contain-intrinsic-size`** on `.canvas-list-item`
skips style, layout and paint for off-screen cards — it cut the per-frame layout
cost of writing transforms from 11.3ms to 7.3ms. It does *not* help the
drag-activation spike (measured: 558ms with it, 541ms without), so don't expect
it to. The dragging card overrides it back to `visible`, since it is transformed
every frame and can leave the viewport.

**`loading="lazy"` on thumbnails** with explicit `width`/`height`, which took a
271-canvas work from 271 image requests to 24.

## Asset import

`triggerAssetImport` kicks off a walk over the manifest's canvases
(`app/aws/lambdas/manifest/importAssets.js`). Each canvas is downloaded from the
source Image API, uploaded to the source bucket, waited on until the `iiif-image`
Lambda has produced its pyramid TIFF, then repointed at our own Image API.
Progress lives in `internal/import-status/{id}.json`, which is what
the UI polls and what `POST /manifests/{id}/import-resume` rewinds.

Two things about the shape of that walk, both learned the hard way:

**`IMPORT_CONCURRENCY` (10) canvases are in flight at once — a sliding window,
not batches.** The moment one finishes the next starts, so a single slow
conversion holds up nothing but itself. (Batching in tens would put a barrier at
every tenth canvas and make the whole run as slow as its worst member.) The slow
part of a canvas is waiting on the conversion, which another Lambda is doing, so
ten wait together rather than end to end.

Because canvases finish out of order, **progress is per canvas, not a cursor**.
`import-status.json` carries `done` (which canvases actually finished) and
`active` (`{index: phase}` for those in flight); `completed` is just `done.length`
for the overall bar. A failed canvas is deliberately left out of `done` so a
resume re-attempts it. `canvasImportState` in `ui/src/components/work/CanvasList.jsx` reads those and
falls back to the old `completed`/`currentIndex` cursor for a status object
written before this existed. Status writes are throttled (`STATUS_THROTTLE_MS`)
and serialized through one promise chain, so a slow write can't land after a
newer one and resurrect stale progress.

**The walk loops inside a single invocation** (`IMPORT_BUDGET_MS`, 10 minutes of
the 15-minute timeout) and only hands off to a fresh invocation when it runs out
of budget — draining what is in flight first, so everything below the handoff
index has been attempted. This is not just a speed choice:

> **Lambda's recursive-loop detection terminates a self-invoke chain after ~16
> hops.** It does so *silently* — no error, no log line, no failure destination.
> The import simply stops and the status object is stranded at `in-progress`
> forever. This is what repeatedly stalled large imports, and it is invisible
> unless you check the `RecursiveInvocationsDropped` CloudWatch metric.

Two defences, and both are needed: looping means a 271-canvas work takes **one**
invocation rather than dozens of hops, and `RecursiveLoop: Allow` on `ManifestFunction`
in `template.yml` opts the function out of the protection for the rare handoff a
genuinely huge work still needs. The walk is bounded by `MAX_CANVAS_INDEX` and
advances monotonically, so opting out is safe — that setting exists for exactly
this case. **Don't remove it**, and if imports start stalling silently again,
check that metric first.

A failed handoff now writes an `error` into the status object so the UI's
staleness check surfaces a Resume button instead of the import looking alive.

## Collections

A work belongs to **exactly one** Collection, changed from the work's own page
via an explicit Move (`LinkingPanel` / `MoveWorkDialog` in
`ui/src/components/work/`). Collections are real IIIF Presentation 3.0
Collection documents in the IIIF bucket, in both spaces:

| | Key |
|---|---|
| Leaf | `{space}/presentation/collection/{slug}/collection.json` |
| Root | `{space}/presentation/collection/index/collection.json` |

There is no uncollected state. Creating a work names a collection — admins
included — and `canMoveWork` refuses a move with no destination. That is what
makes per-collection publishing well defined: with a work in several
collections, "publish this collection" has no single answer for a shared
manifest.

**Membership is authoritative in each manifest's `partOf`. EXISTENCE is
authoritative in the root document.** Those are two different questions, and
splitting them is the load-bearing decision:

- *Which works are in a collection* is still derived from the manifests, so
  `POST /collections/reindex` can repair it from the corpus alone.
- *Which collections exist* is not derivable — an admin-created collection can
  legitimately have no members and nothing in the manifests records it. The root
  document is the register. Reindex therefore **merges**: corpus membership
  union root-declared existence, pruning only what neither knows.

Collections are created and deleted **only by an admin, only on the Collections
screen** (`POST /collections`, `DELETE /collections/{slug}`). Nothing else
instantiates one:

- The Move dialog is selection-only. `handleManifestCollectionRoute` rejects a
  slug the root does not already list, so a work can never conjure a collection
  as a side effect of being saved.
- Emptying a collection does **not** delete it — the leaf is rewritten with
  `items: []`, which the spec permits. This reverses the original "a collection
  with no items ceases to exist" rule.
- `DELETE` refuses a non-empty collection rather than cascading. A cascade would
  rewrite every member's `partOf` — a fan-out write that is easy to trigger by
  accident and hard to undo.

Older notes elsewhere may still describe the auto-delete rule; this section is
the current one.
- `POST /collections/reindex` is a *pure function of the manifest corpus*, so
  any projection damage — a partial write, a hand-edit, a base-URL change — is
  repaired by one call. Under the reverse design a lost object would be
  unrecoverable data loss.

**This applies to the WORKING space only.** `staticiiif:contentHash` on a
published leaf's members is state a *publish event* determines, not the corpus
— so published documents are written by a publish run and by nothing else, and
repair never touches them. That keeps reindex a pure function of the working
corpus, exactly as it always was.

The last point is a constraint, not just a property: **never add collection-level
state that the manifests do not determine.** The moment a collection needs a
curator-authored description, reindex would destroy it and this design needs
replacing with real storage. For the same reason every derived value must be
recomputable — "first member" for a borrowed thumbnail means *first after
sorting by label then id*, not first added.

Ids are slugs of the label ("Environmental Impact Statements" →
`environmental-impact-statements`). **The slug is the identity**: two labels that
reduce to the same slug are the same collection, which is what lets the
autocomplete forgive case and punctuation. A consequence is that renaming a
collection is impossible by construction. `index` is reserved and rejected.

Our `partOf` entries are marked with
`"https://nulib-labs.github.io/static-iiif/ns#managed": true` — an **absolute
IRI**, not a `staticiiif:`-prefixed compact one.

> This was a compact IRI with the prefix declared in `@context`, which is valid
> JSON-LD 1.1 and which **breaks Clover**. Clover normalizes http→https across
> `@context` by calling `.replace()` on every entry, guarding only against
> null — so an inline term-definition object throws
> `r.replace is not a function` and the viewer never renders. Canopy uses
> Clover, so this broke consumers of anything published, not only this app's
> own preview. An absolute IRI expands on its own, so `@context` is the bare
> presentation string again and there is nothing to trip over.
> `normalizeContext` sheds a stale prefix declaration, so a manifest written
> before this heals the next time it is saved. There is a regression test.

An imported manifest's own `partOf` (Northwestern's, say) is preserved verbatim
and never shown as one of ours; `isManagedPartOfEntry` matches on marker-or-path
**and** requires the id to sit under our own base URL, which is what stops us
claiming a collection belonging to another static-iiif deployment.

The works list has no Collection column: every row on a collection page is in
the same collection. It has a **Status** column instead, showing each work's
sync state, and that column is always visible rather than hover-revealed like
the actions cell — a status you have to hover to see is not a status.

The empty-filter row survives from the old collection filter, retargeted to the
`q` filter: when a filter hides every row the table must still render its
header, or the control disappears with the rows and there is no way to undo it.

Routes: `GET /collections` (one GetObject; creates the root if absent),
`GET /collections/{slug}/works` (index-backed; carries the collection label and
whole-collection sync counts so the page needs one request),
`PUT /manifests/{id}/collection` (a move), the three publish routes under
`/collections/{slug}/publish`, and `POST /collections/reindex`
(full rebuild + prune, plus the search index). Reconciliation reads the
**union** of current and desired slugs — never the diff, which would let a retry
short-circuit after a partial failure — and writes leaves, then the root, then
deletions, so the root never advertises a collection whose document 404s.
Reconciliation failure returns 200 with `reconciliation.ok: false`: the
authoritative write already succeeded, so reporting failure would be false in the
direction that matters.

`POST /collections/reindex` reads the whole corpus behind API Gateway's hard
30 s integration timeout, so at a few thousand works it will 504 at the gateway
while the Lambda runs on. It is a rare repair rather than an everyday action —
the working index is maintained write-through and publishing has its own state
machine — but if it needs to scale, the pattern to copy is PublishStateMachine,
not the self-invoke chain in `importAssets.js`.

## Roles and permissions

Two roles, both Cognito Groups, assigned independently — they are a matrix, not
a ladder. A user can hold both; `admin` simply wins wherever they disagree.

| Group | Can |
|---|---|
| `admin` | Everything, including the Users section and `POST /collections/reindex` |
| `editor` | Full control of works inside the collections granted to them, **including publishing them** |
| *(none)* | Sign in and read. No writes at all. |

The Users screen shows a third checkbox, **User**, always checked and always
disabled. It is not a group: it is what holding none of them means, and nothing
is written for it. `normalizeRoles` drops it if a client ever sends it.

A **grant** is a group named `collection:<slug>`. Colon, not hyphen: a slug
contains hyphens, so a hyphen separator would be ambiguous, and Cognito's
GroupName pattern permits Unicode punctuation.

**Why groups and not a permissions document.** Group membership rides in the ID
token as `cognito:groups`, so every authorization decision is a pure function of
claims the JWT authorizer has already verified — no lookup, no store to keep
consistent with Cognito, nothing to cache or invalidate.

The cost is the one thing that will confuse you: **a grant does not take effect
until the user's token is reissued** — their next sign-in, or within the hour
when it refreshes. The Users page says so after every save. Don't "fix" this by
adding a server-side lookup; that trades the whole benefit for an edge case.

### The rules

All of it is in `app/shared/access.js`, which is pure and unit-tested
(`app/shared/__tests__/access.test.js`). Routes call it; they never re-derive a
decision themselves.

- **Reads are scoped too.** You see the collections you hold and the works
  inside them; no role and no grant means an empty app. Every enumerating
  endpoint filters: `GET /manifests/{id}`,
  `GET /manifests/{id}/import-status`, `GET /collections` and
  `GET /collections/{slug}/works`.
- **A grant without a role is read-only sight** of that collection. That is how
  you show someone a collection without letting them change it, and it falls out
  of the model rather than needing a third role.

### What read scoping does and does not do

It bounds what the **dashboard enumerates**. It does not make anything secret.

The IIIF bucket is world-readable on purpose (`Principal: "*"`, `s3:GetObject`)
— Clover fetches manifests unauthenticated, and public resolvability is the
product. Verified anonymously: an individual manifest and any collection
document return 200; only the bucket *listing* is 403. The root collection is
therefore a public index of every collection and its members, walkable by anyone
with the URL.

So scoping stops a signed-in user discovering the corpus **through the app**.
Anyone holding a manifest URL can still read it. Don't describe this as
confidentiality; if that is ever actually needed, it is a bucket-policy and
viewer-architecture change, not an API one.
- **Editing a work** (`canEditWork`) needs a grant on the collection it is in.
- **Creating a work** (`canCreateWork`) requires **exactly one** collection, from
  everyone — an admin included. There is no uncollected state to land in, and an
  editor must hold the collection or they would create something they instantly
  could not edit. The Add Work modal no longer asks: the collection is the page
  you are on.
- **Moving a work** (`canMoveWork`) requires a grant on **both** ends. Pulling a
  work out of someone else's collection and pushing one into someone else's are
  the same kind of act, and an editor may do neither. Re-filing into the
  collection a work is already in is a no-op, so it asks only for what an
  ordinary edit asks.
- **Publishing a collection** (`canPublish`) is admin, or an editor holding that
  collection. Deliberately *not* admin-only the way `canReindex` is: that stayed
  with admins because rebuilding the projection rewrote every collection
  document, and a publish rewrites exactly one — the one the editor was granted.
- **An admin cannot remove their own admin role** (`canAssignRoles`). This is
  what makes the pool un-lockable: the only call that reduces the admin count is
  one admin demoting another, which by definition leaves the caller behind, so
  no sequence of API calls reaches zero admins. The Users screen disables that
  one checkbox — the other two on the same row stay live, so an admin can still
  give themselves `editor`.
- The last-admin check in `users.js` is now a **backstop**, not the primary
  guard: with self-demotion refused it cannot normally fire. It catches the
  admin count being reduced outside the app (an account deleted in the Cognito
  console).

The self-guard compares `principal.sub` to the target's Cognito `Username`.
Those are the same value in this pool — `UsernameAttributes: [email]` makes the
email an alias, so `Username` is the generated UUID. Verified against the
deployed pool, not assumed; if the pool's username config ever changes, this
comparison is the thing that breaks.

### Gotchas

- The **working search index** carries a `collection` keyword field so the works
  list is one query. It is `keyword`, not `text`, because the filter is a
  `term` clause. `ensureIndex` PUTs the mapping even when the index already
  exists (adding a property is idempotent), but existing documents only gain the
  field when they are next written — **a schema change is not live until a
  reindex.**
- The sign-in showcase is built from the **unfiltered** corpus. Deriving it from
  one caller's visible subset would let whoever triggered the rebuild shrink
  what every anonymous visitor sees.
- API Gateway's HTTP API JWT authorizer serializes a multi-valued claim as the
  string `"[admin collection:eis]"`, **not** as JSON. `parseGroupClaim` handles
  that, a real array, and a bare string. Get this wrong and every group silently
  becomes invisible — which fails open on reads and closed on writes.
- The UI has its own copy of the group parsing in `ui/src/lib/session.js`. It
  exists only to shape the UI (hide a section, require a field). The server
  re-derives everything; nothing in the UI enforces anything.

### Bootstrapping

`admin` and `editor` are declared in `template.yml`; grant groups are created on
demand by the API. A fresh stack has **no members in any group**, so nobody can
reach the Users section — the first admin has to be seeded out of band:

```bash
aws cognito-idp admin-add-user-to-group \
  --user-pool-id <pool-id> --username <cognito-username-uuid> --group-name admin
```

`--username` is Cognito's own UUID, not the email: the pool sets
`UsernameAttributes: [email]`, so the email is an alias. `aws cognito-idp
list-users` shows both.

## Lambda runtime SDK

`External: "@aws-sdk/*"` in the esbuild config means every AWS SDK client is
resolved from the **managed** `nodejs22.x` runtime at
`/var/runtime/node_modules`, not bundled. `client-cognito-identity-provider` is
there — verified by esbuild resolving it from that exact path during a build.

Two things that will mislead you if you go looking:

- The **container base image** (`public.ecr.aws/lambda/nodejs:22`) ships *no*
  AWS SDK at all. Probing it tells you nothing about the managed runtime.
- Trying to *bundle* an SDK client fails: esbuild resolves it from
  `/var/runtime/node_modules`, where only `dist-cjs` exists, and then cannot find
  the `@smithy/core` ESM submodules it references. Leave the glob alone.

## Coding Style & Naming Conventions
Use CommonJS modules (`require`/`module.exports`) and 2-space indentation in all Node.js code under `app/`. The UI (`/ui`) uses ESM and JSX. Prefer descriptive, dashed directory names and camelCase identifiers. Strings default to double quotes; async work uses `async`/`await`.

## Design Conventions

The UI is built on Radix Themes (`accentColor="iris"`, `grayColor="mauve"`, `scaling="110%"` in `ui/src/main.jsx`). Reach for a Radix component before hand-rolling one, and use theme tokens (`--gray-N`, `--accent-N`, `--space-N`, `--radius-N`) rather than literal colors or pixel values. Never hardcode a hex — it will not follow the theme.

**Page headings.** Every section gets one centred heading via `PageHeading`
(`ui/src/components/PageHeading.jsx`), and a work's title on its detail page is
the same treatment. Both carry `.page-heading`, which owns the typography — the
size falls between Radix's steps, so it lives in CSS rather than in a `size`
prop. `.work-title-editable` adds only the click-to-edit chip, so an editable
title and a static one cannot drift apart.

Two traps:

- Radix's `Text` accepts `as` of `span | div | p | label` **only**. Anything else
  is silently rendered as a `<span>` — no error, no warning. That is how the work
  title ended up not being a heading element. `PageHeading` uses
  `<Text asChild><h2>` instead.
- They must carry `font-family: var(--heading-font-family)` explicitly. These
  render as Radix `Text`, whose default family is Google Sans — which is loaded
  at **400/500/600/700 only**, so a `font-weight: 800` on it is *synthesized*
  into a smeared faux-bold rather than refused. Google Sans Flex Variable
  carries a real `1 1000` weight axis and is the only way to get a true black.
  Verify with `document.fonts.check('800 44px "<family>"')` before assuming a
  weight exists; enumerate `CSSFontFaceRule`s to see what is actually declared.

The `<h1>` is the "Understory" wordmark in `AppShell`, so page headings are `h2`.

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

**Comboboxes and popups.** Radix Themes has no combobox, and neither `DropdownMenu`
nor `Popover` can back one: both move focus into the popup, which makes typing
impossible. Build one as a plain absolutely-positioned `<ul role="listbox">`
anchored to a `position: relative` wrapper, with
`onMouseDown={e => e.preventDefault()}` on every option so focus never leaves the
input (which also means no ref and no document listener). Note
`.rt-TextFieldRoot` has a **fixed height and does not wrap**, so chips belong
above the field, not inside it. Radix `Card` sets `contain: paint`, so the Clover
viewer's `z-index: 99999` is trapped in its own stacking context and a modest
`z-index` on the listbox is enough.

> There is no live example in the tree any more. `WorkCollectionsField` was the
> worked one until a work became a member of exactly one collection, at which
> point a 350-line control for editing a *set* had no problem left to solve and
> was replaced by a Move dialog. The rule above still holds for the next one.

Any rule that overrides `.canvas-label-editable` (which sets
`align-self: flex-start`) must use a two-class selector so it wins regardless of
source order, and must live in `ui/src/App.css` — component stylesheets under
`ui/src/components/` are imported *before* `App.css`, so an equal-specificity
override there would silently lose.

Since `App.jsx` was split up, `AppShell.jsx` is the **only** importer of
`App.css`, which is what keeps it last. Do not add a second importer earlier in
the graph, and do not split the file — the fluid-scale and token blocks at its
head must load exactly once, before every component stylesheet.

**Fluid scale — read this before writing any pixel value.** Nothing on the page
is a fixed size. One viewport-driven unit in `ui/src/App.css` drives type,
spacing, control heights, radii and the container together: **0.95x at 1024px
wide, 1.10x at 1600px, 1.35x at 2560px**, clamped outside that range. 1600px is
the anchor — at exactly that width the page renders identically to the old fixed
design.

Radix's own `scaling` prop is *not* the lever, and cannot be. It is a **unitless**
multiplier (every token is `calc(Npx * var(--scaling))`), and CSS cannot multiply
a length by a length — feeding it `vw` invalidates all 42 token declarations and
collapses the theme. Both tricks for extracting a unitless number from `vw` are
out: `calc(100vw / 1px)` is unsupported in Firefox, and `tan(atan2(1vw, 1px))`
rides an open Firefox precision bug. So `App.css` bypasses `--scaling` and
redefines `--space-*`, `--font-size-*`, `--line-height-*`,
`--heading-line-height-*` and `--radius-*` against a fluid *length*.

**There are two units and they are not interchangeable:**

| | value at 1600px | multiplies |
|---|---|---|
| `--u` | 1.10px | Radix's base numbers (4, 8, 12, 24…) — the values *before* `--scaling` |
| `--px` | 1.00px | values we measured by eye against the already-scaled rendering |

**A hand-measured value `V` in our CSS becomes `calc(V * var(--px))`.** Radix base
numbers use `--u`. Getting these backwards inflates by exactly 1.1x and silently
breaks the anchor — `calc(1400 * var(--px))` is the 1400px container;
`calc(1400 * var(--u))` would be 1540px. Prefer an existing token
(`var(--space-4)`, `var(--radius-2)`) over either unit whenever one fits.

Deliberately **not** scaled: hairline borders, focus rings, `box-shadow`
offsets, pill radii (`999px`), and the `1px` clip on `.nu-wordmark-label` (that
is a visually-hidden trick, not a size). **`rem` values are left alone on
purpose** — `html { font-size }` is fluid, so every `rem` in the app follows for
free, including the `rem` strings `AssetThumbnails.jsx` emits into inline styles.
That root font-size is written additively (`calc(1rem + …)`) so it preserves the
user's configured default at the anchor instead of overwriting it.

That root font-size is also the only lever this repo has on the **Clover viewer**,
whose chrome is ~250 `rem` values and unreachable through its theme API
(`cloverTheme.js` can only set colours). Do not scale `.viewer-panel` /
`.viewer-stage` independently of everything else — that grows the frame while
Clover's own px tokens stay put and makes the mismatch worse.

Two accepted consequences: below ~1400px the app is smaller than the old fixed
design (7% at 1280, 14% at 1024), and browser zoom is ~14% less effective, since
zooming shrinks the CSS viewport and pushes the unit toward its floor.

**Typography.** Two faces, split by role in `ui/src/App.css`:
`--default-font-family` (and `--strong-font-family`) is the static **Google Sans**
for body copy; `--heading-font-family` is **Google Sans Flex Variable**, used for
headings only. The reason is the weight axis — the static face ships 400/500/600/700
and stops there, so a heading could not sit heavier than bold. The variable cut
runs 1–1000, which is what `.app-wordmark` (`font-weight: 800`) depends on.

Import the **`wght`** entrypoint, not `full`: the weight-axis file is ~50KB, while
the all-axes build (which would additionally bring the optical-size axis) is 1.4MB.
The optical-size axis is what a separate "Display" cut would give you, and it is not
worth that much for a heading face. There is no `@fontsource/google-sans-display`
package; this is the closest thing.

`.rt-Heading` carries `letter-spacing: -0.02em` so every heading tracks a little
tighter — the display face is roomier than the text face, so Radix's default
tracking reads loose at heading sizes.

The tokens are declared on `:root, .radix-themes` together. Radix redeclares its scales on `.radix-themes`, so a token defined only on `:root` resolves against the bare document and silently misses the active theme's gray/accent — the same trap that applies to the font-family overrides above it.

## Testing Guidelines
Add tests alongside code under `app/**/__tests__/` with filenames ending in `.test.js`. Run them with `npm test` (Node's native runner). Keep fixtures small under `app/<module>/__fixtures__`.

Tests must not require the AWS SDK: the repo root declares no dependencies, so nothing under `node_modules` resolves there and any module that `require`s `@aws-sdk/*` at load time is untestable locally.

That is the reason for the split in `app/shared/`, and it is worth keeping deliberately:

| SDK-free, unit-tested | Loads the SDK, not testable from the root |
|---|---|
| `space.js`, `collection.js`, `publish.js`, `search.js`, `access.js`, `language.js` | `manifest.js`, `opensearch.js` |

Keep `collection.js` free of any `manifest.js` import — `manifest.js` loads the SDK, and the reverse direction would also be a require cycle. `node:crypto` is a core module, so hashing in `publish.js` is fine.

There are **no UI tests**. A frontend change's test plan is the manual verification steps in its PR.

Since the Lambdas cannot be unit-tested, the cheap backend checks worth running before a deploy are:

```
npm test                                   # 78 pure tests
cd app && npx esbuild aws/lambdas/manifest/index.js --bundle \
  --platform=node --target=node22 '--external:@aws-sdk/*' --outfile=/dev/null
cd app/aws && sam validate --lint          # offline; needs no credentials
```

esbuild resolving the whole graph catches a missing export or a require cycle, and `eslint` in `ui/` has `no-undef` on, which catches a variable that failed to move during a refactor. Note eslint's `varsIgnorePattern: ^[A-Z_]` means it will **not** flag an unused component or icon import — those have to be found by hand.

## Commit & Pull Request Guidelines
Use Conventional Commits (`feat:`, `fix:`, `chore:`, etc.) from the start. Reference related GitHub issues in the PR body. Include manual verification steps (`npm test`, sample render) so reviewers can reproduce. Keep PRs focused; split unrelated work into separate branches.
