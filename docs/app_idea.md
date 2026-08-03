# 🚀 Project Name: Tubeshelf

## 1. Core Concept & Value Proposition
> A self-hosted YouTube "subscription" tracker - tracks watched and unwatched videos in a queue system with tags and/or categories for improved UX over the real YouTube Subscription page. Videos are still viewed on YouTube itself to allow Brave browser to block ads and full SponsorBlock support

- **Problem Statement:** The YouTube Subscription page is clusmy/busy and does not allow sorting by categories/tags - making it hard to view at a glance what is un-watched
- **Target Audience:** Myself - Users with many subscriptions but very different categories (Podcasts (long duration), Let's Plays, Programming Tutorials, Tech Video, Cooking, Fun) that should be split into different views as the 'watch mode' is different for each type of video and time able to view
- **Key Differentiator:** More control on what videos the user wants to watch as well as being able to filter and reduce noise presented (category filtering on the queue views scoped in docs/specs/006-category-queue-filtering.md)

## 2. Feature Scope
### MVP (Minimum Viable Product)
*The 3-5 absolute must-haves for launch.*
1. User is able to add YouTube channels to an overall subscription page, assigning each channel to exactly one **category** (free-text, user-defined). Channels left unassigned default to a system-managed **"Uncategorized"** category, which is not itself user-selectable or creatable. For MVP, the user must supply the channel's ID (or channel URL/RSS URL) directly at subscribe time - the subscribe page should include copy guiding them to find it via `/channel/` or `channelId` in the channel's page source (refined in docs/specs/008-mvp-completion-gaps.md — the actual instructional copy). Handle-based (`@handle`) lookup is deferred (see Future Roadmap).
2. The application will via a scheduled job fetch each channel's RSS feed and populate its listing of videos. Fetches are staggered/jittered across channels on an hourly cadence (not all channels polled simultaneously) to avoid hammering YouTube from a single self-hosted IP. Ingested videos are upserted keyed on YouTube's video ID, so repeated polls don't create duplicates. (Refined in docs/specs/003-scheduled-video-ingestion.md — the scheduler, the eager subscribe-time ingest, and the gap-detection flag's persistence logic.)
3. The application tracks a three-state watch status per video: **Unwatched**, **Watching**, **Watched** (see *Watch Flow* below for the click-to-watch UX). The main subscription/queue page also exposes a manual status toggle per video: for Watched/Unwatched videos it flips between the two; for a video currently **Watching**, it clears the video back to **Unwatched** (this is the only path back from Watching - the Watching page itself only ever moves a video forward to Watched).
4. **Firm constraint, not just a preference:** no YouTube Data API usage, to keep setup friction at zero. This is a deliberate tradeoff, not an oversight - it's why the RSS feed's 15-video window and missing duration data (see *Ingestion Notes*) are accepted limitations rather than problems to solve by reaching for the API mid-build.
5. Users can unsubscribe from a channel (refined in docs/specs/002-channel-subscriptions.md — unsubscribing no longer deletes any videos; it only deactivates the subscription, and all video history/state is preserved and restored on re-subscribe).
6. Videos can be manually marked **Ignored** (a general noise filter, e.g. for Shorts or anything else uninteresting), removing them from the default queue and Continue Watching views; a dedicated **Ignored** view lists them for review/undo. A global, user-managed list of keyword/substring rules (e.g. `#shorts`; add/edit/delete supported) is checked case-insensitively against incoming video titles and descriptions at RSS ingestion time - a match auto-sets the video to Ignored immediately rather than landing in the normal queue first.
   - Each Ignored video tracks *how* it was ignored - **manually** (explicit user action) or **auto** (matched a rule). Whenever the rule list changes (add/edit/delete), the full rule set is re-run: every **auto**-ignored video that no longer matches any rule is un-ignored back to Unwatched, and every Unwatched/Watching video that newly matches gets auto-ignored. **Manually**-ignored videos are never touched by this reconciliation - only an explicit un-ignore action clears them. Manually triggering Ignore on an already auto-ignored video converts it to manual, "locking it in" against future rule changes (deferred in docs/specs/007-ignore-rules-and-ignored-view.md - no UI surface for this exists yet, since auto-ignored videos never appear on the views where the manual Ignore action lives; auto-ignored videos stay reconcilable by rule changes indefinitely unless explicitly un-ignored).

### Watch Flow (MVP)
- Clicking a video opens the YouTube link in a new browser tab (fire-and-forget - no tab monitoring needed) and navigates the current app view to a **Watching page** showing the video's thumbnail and title.
- The Watching page auto-marks the video as **Watching** after a 10-second client-side timeout, unless the user navigates away first. This timeout is not persisted server-side - if interrupted (tab/page closed early), nothing is recorded, by design.
- The 10-second auto-Watching timeout does not fire when revisiting a video that is already marked **Watched**.
- The Watching page offers three actions (refined in
  docs/specs/004-watch-flow-queue-views.md — "Return to Queue" is actually "smart":
  it and the Mark Watched/Unwatched action both navigate back to whichever view -
  default queue, Continue Watching, or Watched - the video was actually opened from,
  not a hardcoded queue page, and the queue's current sort order round-trips too):
  - **Mark Watching** - explicitly set to Watching immediately (bypasses the 10s timeout) and stay on the page
  - **Mark Watched & Return to Queue** (label flips to **Mark Unwatched & Return to Queue** when revisiting an already-Watched video) - update status and navigate back
  - **Return to Queue** - pure navigation, no status change, even if the 10s auto-Watching timeout already fired
- Queue views (refined in docs/specs/004-watch-flow-queue-views.md — the default queue
  and Continue Watching views below are scoped to the current user's
  actively-subscribed channels, so an unsubscribed channel's preserved video history
  does not reappear in either; **Watched** is the one exception - see below):
  - Default queue view = Unwatched &cup; Watching videos (excludes Ignored), sorted **newest to oldest** by default with a toggle to invert to oldest-to-newest (the toggle UI itself added in docs/specs/005-subscribe-default-category-and-queue-sort-toggle.md — spec004 built the underlying `?sort=` plumbing but left the visible toggle unbuilt)
  - **Continue Watching** view = Watching videos only
  - **Watched** view (added in docs/specs/004-watch-flow-queue-views.md; now a fully
    implemented, first-class view alongside the two above) = a true watch history: every Watched video, sorted
    most-recently-watched-first, and **not** scoped to active subscriptions - a video
    stays visible here even after unsubscribing from its channel, since watch state is
    already guaranteed to survive unsubscribe. Click-through only (no inline
    un-watch/toggle action - use the Watching page's existing unmark action instead).
  - All three views above can be narrowed to a single category at a time, including the
    system Uncategorized category (docs/specs/006-category-queue-filtering.md); the
    **Ignored** view below gets the same category filter (docs/specs/007-ignore-rules-and-ignored-view.md).
  - **Ignored** view = Ignored videos only, with an un-ignore action (reverts to Unwatched) for reviewing/undoing mistaken ignores. Scoped to active subscriptions like the default queue and Continue Watching views above, not true history like Watched (docs/specs/007-ignore-rules-and-ignored-view.md).

### Ingestion Notes (MVP)
- YouTube's channel RSS feed is an **unofficial, undocumented endpoint** - it could change format or access rules with no notice, and the whole "zero API" architecture has no fallback if that happens. This is an accepted risk, not something to be surprised by later.
- The feed only returns the **most recent 15 videos** per channel. If the fetch job is down for a while, or a channel bulk-uploads, older videos can silently never be ingested.
  - To catch this: on each fetch, compare the oldest video returned by the feed against the newest video already stored for that channel. If there's a gap (the feed's oldest entry is newer than what's already stored), flag the channel as **"possible missed videos."**
  - The flag is manually dismissed (there's no way to backfill the actual missing videos, so this is just a "go check manually" signal, not a self-healing state). (Refined in docs/specs/008-mvp-completion-gaps.md — dismissal is per-subscription, not global, since the flag lives on the shared channel entity but "have I seen this notice" is inherently a per-user preference.)
- The feed does include description text and view count (`media:description` / `media:statistics`, confirmed against a live feed) - but has **no duration** field anywhere. Duration-aware timers and reliable Shorts type-detection still aren't possible without an additional per-video data source (out of scope for MVP); the description text that *is* available is what makes the keyword-based IgnoreRule matching (MVP item 6) viable without extra fetches (view count is present in the feed too, but nothing currently captures or uses it).

### Future Roadmap (v2.0)
*Features to implement only after the MVP is stable.*
- Per-video tags (many-to-many), layered on top of the MVP's one-category-per-channel model, so individual videos could appear in multiple tag views without needing to reclassify the whole channel
- Subscribe by `@handle` or channel URL directly, resolved to a channel ID by scraping the channel page's canonical/meta tags server-side (rather than requiring the user to find the ID themselves as in MVP)
- User registration and multi user support
- In app video watching (not link out)
  + Still requires Brave browser ad blocking and SponsorBlock support
- Support other platforms than YouTube - Long term goal, I currently do not have any other platforms in mind
- Application is in a place to be made public as an open source project, with enough documentation that I might be able to manage Pull Requests reasonably if there were any

### Path to v1.0 (post-MVP-feature sequencing)
*A loose plan, not a locked spec order — expect this to shift as work progresses. This
section is the source of truth for the intended order (not any AI assistant's session
memory, which doesn't follow across the two dev machines this project is built on).*

Once all numbered MVP feature items above are implemented, the intended order of
remaining pre-v1.0 work is:

1. **Styling** — the UI is currently unstyled/ugly; Tailwind is already wired in
   (§3). Sequenced before auth deliberately: this project's specs lean on manual
   browser verification heavily, and once login/session middleware exists, every such
   pass requires authenticating first — doing the visual-iteration-heavy work while the
   app is still auth-free keeps that loop cheap.
2. **Auth/CSRF** (§5's requirements) — sequenced right before deployment (below), not
   immediately after MVP features finish, because its urgency comes from the app
   actually being exposed (the tunnel-to-internet posture in §5), not from existing in
   the abstract. Costs nothing to defer while the app is dev-only and undeployed.
   (Refined in docs/specs/012-auth-and-csrf.md — username/password + DB-backed sessions,
   lockout, env-var recovery, and Origin-allowlist CSRF, designed to support the intended
   multi-domain deployment of NGINX Proxy Manager on the LAN alongside a Cloudflare Tunnel
   for WAN access.)
3. **DB squash** — collapse all migrations accumulated during MVP + styling + auth
   development into one clean baseline. Deliberately the *last* schema-touching spec
   here, not right after MVP features finish — auth (above) will likely add its own
   schema (session/token storage, login-attempt tracking for the rate-limiting §5
   requires), so squashing after it catches that dev-time churn too instead of leaving
   it to accumulate past an earlier squash. Safe to do this aggressively since the app
   has never been deployed — no real user data/migration path to preserve yet.
   (Refined in docs/specs/013-db-squash-and-admin-rename.md — also folds in an unrelated
   small rename, from the seeded single user's username `default` to `admin`, riding
   along since it shares the same no-real-data-at-stake property.)
4. **Deployment/Docker packaging** (§3's compose-file infrastructure, deferred since
   spec001 since there was no app yet to containerize).
5. **GitHub buildout** (CI, release image pushing, §6's CI/CD Pipeline) — sequenced
   last, once there's an actual release artifact shape to automate around, rather than
   chasing a moving packaging target.

### User Roles & Permissions
| Role | Permissions |
| :--- | :--- |
| **Guest** | Sign up - Post MVP |
| **User** | Manage _their_ channel Subscriptions and watched history |
| **Admin** | Manage users - Post MVP |

## 3. Technical Architecture
- **Frontend:** HTMX + Tailwind CSS. Server-rendered HTML with small partial updates fits this app's shape (queue list, status toggles, watching page) well, and pairs naturally with BunJS serving HTML directly. Deliberately chosen over React/TS (the user's day-job stack) as a low-stakes chance to learn HTMX; Tailwind kept since it's already familiar-ish from work even though not deeply known
- **Backend:** BunJS Full Stack - Pretty firm on this as I'd like to learn but I'd be willing to look at other platforms if they fit better
- **Database:** SQLite - BunJS SQLite built in support and/or an ORM. Use **WAL mode** (`PRAGMA journal_mode=WAL`) to avoid `SQLITE_BUSY` contention between the scheduled RSS-fetch job and concurrent web requests - `bun:sqlite` is a direct binding to the SQLite C library, so this works the same as anywhere else. Migration tooling (ORM-provided vs. bespoke versioned SQL) is TBD, to be decided during implementation (resolved in docs/specs/001-bootstrap-repo-scaffold.md — Drizzle ORM).
- **Infrastructure:** Self-hosted via a Docker container via a compose file
- **Third-Party APIs:** Ideally zero APIs

## 4. Data Model & Schema
*Core entities and relationships.*
- **User:** MVP runs as a single implicit user, but the schema should still model a `User` record now so v2.0 multi-user support doesn't require a breaking migration
- **Category:** User-defined free-text label (reasonable length limit - 100 characters, refined in docs/specs/008-mvp-completion-gaps.md). Exactly one system-managed **"Uncategorized"** default exists and is not user-creatable/selectable. Rename is supported by updating the Category row in place (every Channel/Video referencing it via foreign key picks up the new name immediately) (refined in docs/specs/008-mvp-completion-gaps.md — adds the actual rename route; the live FK-join behavior itself needed no change). No explicit delete operation is needed for MVP - a category with zero channels attached just stops appearing anywhere; it can linger harmlessly or be auto-pruned later.
- **Channel:** A subscribed YouTube channel; belongs to exactly one Category (defaults to "Uncategorized" if none chosen at subscribe time). Flagged `possible_missed_videos: bool` (manually dismissed) per the RSS gap-detection check in *Ingestion Notes*. (Refined in docs/specs/002-channel-subscriptions.md — split into a global `YoutubeChannel` entity, shared across users and never deleted, plus a per-user `Subscription` join record carrying the Category and active/unsubscribed state, so a channel isn't tied 1:1 to the user who first added it. Unsubscribing deactivates the Subscription only; no Video rows are ever deleted.)
- **Video:** Belongs to exactly one Channel; has a watch status of `unwatched | watching | watched | ignored`, plus `ignore_method: manual | auto | null` (null unless status is `ignored`) tracking how it got ignored. Keyed on YouTube's own video ID (unique constraint) so RSS ingestion **upserts** rather than inserting duplicates on repeated polls. Un-ignoring reverts status to `unwatched` and clears `ignore_method` (in-progress state isn't preserved through an ignore/un-ignore cycle). (Refined in docs/specs/004-watch-flow-queue-views.md — adds `watched_at: timestamp | null`, non-null exactly when status is `watched`, powering the Watched history view's most-recently-watched-first sort; cleared whenever a video stops being `watched`, so it never reflects a stale prior watch.)
- **IgnoreRule:** A global, user-managed keyword/substring (e.g. `#shorts`), supporting add/edit/delete. Checked case-insensitively against a Video's title/description at ingestion time; a match sets status to `ignored` with `ignore_method: auto`. Any add/edit/delete to the rule list triggers a full reconciliation pass over `auto`-ignored and Unwatched/Watching videos (see MVP item 6) - `manual` ignores are never touched by this pass.
- **Relationships:** (refined in docs/specs/002-channel-subscriptions.md per the Channel/Subscription split above)
  - Category 1-to-many Subscription (one category has many subscriptions; each subscription has exactly one category)
  - YoutubeChannel 1-to-many Video (one channel has many videos)
  - User 1-to-many Subscription (modeled now for future multi-user support; single implicit user for MVP); YoutubeChannel 1-to-many Subscription (many users can subscribe to the same channel)
  - IgnoreRule is global for MVP (not scoped to a Channel/Category - see Future Roadmap)
- **Future (v2.0):** Video-to-Tag many-to-many, layered on top of the channel-level Category, if per-video tagging proves needed post-MVP; IgnoreRule scoped per-Channel/Category instead of global

> **Scalability Notes:** Long term support for database migrations for users (myself) to be able to update via `docker compose pull` and have the application migrate and run the new version

## 5. Security & Authentication
- **Auth Strategy:** Simple username/password auth - application is expected to run inside a local network OR open to internet via a secure method such as Cloudflare Tunnels - long term OTP support would be nice but that is v3+ concern
- **Authorization Rules:** See User Roles & Permissions
- **Data Protection:** User Passwords at least Bcrypt + salt, other data to encrypt TBD
- **Baseline hardening (required before deployment, not a blocker for MVP-as-delivered - see *Path to v1.0* step 2 below, which deliberately sequences this right before deployment rather than immediately after MVP features, since its urgency comes from the app actually being exposed):** Since the app may be exposed to the internet (not just LAN), a tunnel alone doesn't protect the login form - basic rate-limiting/lockout on login attempts is required. State-changing HTMX requests (mark watched, add/remove channel, rename category, etc.) require CSRF protection. (Refined in docs/specs/012-auth-and-csrf.md — 5-attempt/15-minute lockout keyed by username, Origin-header allowlist CSRF.)
- **Compliance:** None

## 6. Development Workflow & DevOps
- **Version Control:** Git based VC, pull requests workflow once the application is in a working state - at least by MVP state
- **Development Pattern:** Ideally via Spec-Driven Development with an AI agent
- **Development Workflow:** `.devcontainer` workflow as I develop on two different devices one running Bazzite Fedora 44 and another just Fedora 44
- **CI/CD Pipeline:** TBD - probably whatever I can get away with for free on GitHub
- **Environment Variables:** None expected for MVP, but might need adjustment
- **Testing Strategy:** 
  - Unit Tests: Bun Test Runner
  - E2E Tests: TBD

## 7. Monetization & Maintenance (Optional)
- **Revenue Model:** Free Open Source Software
- **Estimated Monthly Cost:** 0 is the only acceptable answer
- **Maintenance Plan:** As the deployment pattern is via Docker users should be able to backup the SQLite DB and be good.

---
*Created: 07/18/2026* | *Status: In Progress - see docs/specs/ for what's implemented*
