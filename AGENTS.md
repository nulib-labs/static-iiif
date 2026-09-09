# Repository Guidelines

## Project Overview
This project generates static IIIF Image 3.0 API resources and IIIF Presentation 3.0 manifests for a collection of images, deployed entirely on AWS. A SAM application (`app/aws/template.yml`) provisions a source S3 bucket and an output S3 bucket (`*-iiif`). An S3-triggered Lambda (`app/aws/lambdas/iiif-image/`) converts uploaded source images to pyramid TIFFs (Level 2) for use by `samvera/serverless-iiif` (a nested SAR application). A second Lambda (`app/aws/lambdas/manifest/`) exposes a CRUD API (behind API Gateway + Cognito auth) for managing IIIF Presentation 3.0 manifests. A third Lambda (`app/aws/lambdas/search/`) maintains a title search index for those manifests in an existing, shared AWS OpenSearch domain (not provisioned by this repo) — see "Search index" below. A React/Vite frontend (`ui/`) talks to all three, and is hosted via Amplify.

The project metadata CSV → manifest generation flow described in earlier iterations is still a future goal; today the manifest API supports single-manifest CRUD plus the Collections routes described below.

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
| `/works/:workId?` | `App` (`ui/src/App.jsx`) | Built |
| `/collections` | `CollectionsPage` | Stub — read-only list |
| `/users` | `UsersPage` | Built — admin only |

Anything else redirects to `/works`.

- **Works** — create/manage IIIF Presentation manifests (the
  `presentation/manifest/` prefix in the IIIF bucket) and preview the selected
  manifest via Clover Viewer. Assets are uploaded per-work through
  `AssetDropzone`, which writes to the `image/` prefix of the **source** bucket
  (not the IIIF/output bucket) — that upload is what feeds the `iiif-image`
  Lambda's pipeline. The Cognito authenticated role's IAM policy scopes
  `s3:PutObject`/`s3:GetObject` to `image/*` only; the bucket root is
  intentionally not writable (or listable) from the UI.
- **Collections** — see the Collections section below. Read-only today: it lists
  the root collection's members. There is deliberately no create/rename/delete
  here, because membership is authoritative in each manifest's `partOf` and a
  collection only exists while a work points at it.
- **Users** — lists the Cognito user pool and assigns roles and collection
  grants. Admin-only, hidden from the section menu for everyone else. See
  "Roles and permissions" below.

Sections are horizontal `NavLink`s on the wordmark line. With three
destinations, a dropdown cost a click and said less than simply showing them.
`NavLink` marks itself active for a path *and everything under it*, so `/works`
stays lit on `/works/:workId` with no path matching in the shell, and it sets
`aria-current` for free. The active underline is painted transparent on every
link so becoming active never changes a link's height.

Adding a section means one entry in `SECTIONS` plus one `<Route>`.

`ui/src/lib/api.js` holds the Amplify configuration, the deployed endpoint bases
and `apiFetch`. It lives outside `App.jsx` so a section that is not Works can
call the API without importing the whole works UI. Importing it is what
configures Amplify, so every `apiFetch` caller is configured by construction.

Future: a prefix for audio/video assets (A/V) is anticipated but out of scope for
now — don't build it until it's explicitly requested.

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
| `VITE_COLLECTION_API_URL` | The `ManifestHttpApi` endpoint's `/collections` path. Needed as its own variable because `VITE_MANIFEST_API_URL` already ends in `/manifests`; the UI derives a fallback from it, but set this explicitly. **Every `VITE_*` must also be added to the `define` block in `ui/vite.config.js`** — Amplify injects them as process env vars, which Vite's own `.env` handling never sees, so a missing entry is `undefined` in production and fine in dev. |
| `VITE_STORAGE_BUCKET` / `VITE_STORAGE_REGION` | The IIIF output S3 bucket and its region. `STORAGE_BUCKET` also configures Amplify's default `Storage.S3` bucket (used for Auth/Storage bootstrap). |
| `VITE_SOURCE_BUCKET` | The source S3 bucket (uploads land here, under `image/`, and trigger the `iiif-image` Lambda). Used by the Assets tab's Storage Browser location. |
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

It is refreshed from `GET /manifests` (`refreshShowcase`), which has already paid
for the corpus read, using read-compare-write so an unchanged corpus writes
nothing. That means no separate trigger to forget about. Tiles are requested as
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
Progress lives in `presentation/manifest/{id}/import-status.json`, which is what
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
resume re-attempts it. `canvasImportState` in `ui/src/App.jsx` reads those and
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

A work can belong to zero or more Collections, edited from the work's own page
(`WorkCollectionsField` in `ui/src/App.jsx`). Collections are real IIIF
Presentation 3.0 Collection documents in the IIIF bucket:

| | Key |
|---|---|
| Leaf | `presentation/collection/{slug}/collection.json` |
| Root | `presentation/collection/index/collection.json` |

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

- The Linking tab's combobox is selection-only. `handleManifestCollectionsRoute`
  rejects a slug the root does not already list, so a work can never conjure a
  collection as a side effect of being saved. (This reverses the earlier
  "hit enter and it creates" behaviour.)
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

Our `partOf` entries are marked `"staticiiif:managed": true`, with the prefix
defined in the manifest's `@context` array (extensions first, the presentation
context **last**, per the spec). The namespace URI ends in `#` — without a
gen-delim JSON-LD 1.1 will not expand the compact IRI. An imported manifest's
own `partOf` (Northwestern's, say) is preserved verbatim and never shown as one
of ours; `isManagedPartOfEntry` matches on marker-or-path **and** requires the id
to sit under our own base URL, which is what stops us claiming a collection
belonging to another static-iiif deployment.

`WorkCollectionsField` deliberately has **no "Create" row** in its suggestion
list: Enter creates whatever is typed, and Check commits any text still sitting
in the input before saving, so a name is never silently discarded for not having
been turned into a chip first. Suggestions are existing collections only, and
only an explicit arrow-key or pointer selection highlights one — Enter otherwise
uses exactly what was typed, so the result never depends on invisible state.
Typing a name that normalizes onto an existing collection joins it rather than
forking it, which is what makes plain-Enter safe.

The works list carries a **Collection** column whose header is its own filter
(`CollectionFilterHeader`). Filter options are derived from the loaded works, not
from the collections vocabulary, so the menu can never offer something that
matches nothing; a filter whose collection later disappears falls back to showing
everything. When a filter empties the table the header still renders — otherwise
the control vanishes with the rows and the filter cannot be undone. The search
results table gets the same column by joining hits against the loaded works
client-side: **do not add collections to the OpenSearch document**, which stays
deliberately minimal.

Routes: `GET /collections` (one GetObject; creates the root if absent),
`PUT /manifests/{id}/collections` (sets the whole managed set), and
`POST /collections/reindex` (full rebuild + prune). Reconciliation reads the
**union** of current and desired slugs — never the diff, which would let a retry
short-circuit after a partial failure — and writes leaves, then the root, then
deletions, so the root never advertises a collection whose document 404s.
Reconciliation failure returns 200 with `reconciliation.ok: false`: the
authoritative write already succeeded, so reporting failure would be false in the
direction that matters.

`POST /collections/reindex` inherits the same hard 30 s API Gateway integration
timeout as `POST /search/reindex`; at a few thousand works it will 504 at the
gateway while the Lambda runs on. The escape hatch is the self-invoke +
status-object pattern `importAssets.js` already uses.

## Roles and permissions

Two roles, both Cognito Groups, assigned independently — they are a matrix, not
a ladder. A user can hold both; `admin` simply wins wherever they disagree.

| Group | Can |
|---|---|
| `admin` | Everything, including the Users section and `POST /collections/reindex` |
| `editor` | Full control of works inside the collections granted to them |
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
  endpoint filters: `GET /manifests`, `GET /manifests/{id}`,
  `GET /manifests/{id}/import-status`, `GET /collections`, and `GET /search`.
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
- **Editing a work** needs a grant on at least one collection it is currently in.
  A work in *no* collection is therefore admin-only.
- **Creating a work** requires the editor to name a collection they hold — hence
  the extra field in the Add Work modal. Without it they would create something
  they instantly could not edit.
- **Changing membership** requires a grant on every collection being added *or
  removed*, so an editor cannot quietly evict a work from someone else's
  collection while editing it.
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

- The **search index** carries a `collections` keyword field so a query can be
  scoped without joining the manifest corpus. It is `keyword`, not `text`,
  because the filter is a `terms` clause. `ensureIndex` PUTs the mapping even
  when the index already exists (adding a property is idempotent), but existing
  documents only gain the field on the next `POST /search/reindex` — **a schema
  change here is not live until you reindex.**
- `GET /manifests` filters what it returns but builds the public sign-in
  showcase from the **unfiltered** corpus. Deriving the showcase from one
  caller's visible subset would let whoever loads that route next shrink what
  every anonymous visitor sees.
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
impossible. `WorkCollectionsField` is the worked example — a plain
absolutely-positioned `<ul role="listbox">` anchored to a `position: relative`
wrapper, with `onMouseDown={e => e.preventDefault()}` on every option so focus
never leaves the input (which also means no ref and no document listener). Note
`.rt-TextFieldRoot` has a **fixed height and does not wrap**, so chips belong
above the field, not inside it. Radix `Card` sets `contain: paint`, so the Clover
viewer's `z-index: 99999` is trapped in its own stacking context and a modest
`z-index` on the listbox is enough.

Any rule that overrides `.canvas-label-editable` (which sets
`align-self: flex-start`) must use a two-class selector so it wins regardless of
source order, and must live in `ui/src/App.css` — component stylesheets under
`ui/src/components/` are imported *before* `App.css`, so an equal-specificity
override there would silently lose.

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

Tests must not require the AWS SDK: the repo root declares no dependencies, so nothing under `node_modules` resolves there and any module that `require`s `@aws-sdk/*` at load time is untestable locally. That is why the pure logic lives in `app/shared/` (`collection.js`, `language.js`) and the IO lives in the lambda modules — keep that split when adding code, and keep `app/shared/collection.js` free of any `manifest.js` import (`manifest.js` loads the SDK, and the reverse direction would also be a require cycle). Any new tiling or presentation feature should include at least a smoke test and validation against a sample IIIF document.

## Commit & Pull Request Guidelines
Use Conventional Commits (`feat:`, `fix:`, `chore:`, etc.) from the start. Reference related GitHub issues in the PR body. Include manual verification steps (`npm test`, sample render) so reviewers can reproduce. Keep PRs focused; split unrelated work into separate branches.
