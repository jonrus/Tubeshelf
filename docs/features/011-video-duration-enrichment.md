---
status: refined
created: 2026-09-05
---

# Video Duration Enrichment

## Problem / Motivation
YouTube's channel RSS feed (the app's sole video-discovery mechanism) has no duration field
anywhere. `docs/app_idea.md`'s Ingestion Notes calls this out explicitly as an accepted MVP
limitation, and MVP item 4 goes further: it states a firm, deliberate constraint of **no
YouTube Data API usage at all**, specifically to keep setup friction at zero, naming the
missing-duration gap as the accepted cost of that choice.

Quota research (done in conversation, verified against Google's official quota docs,
2026-09-05) shows this constraint is stricter than it needs to be: `videos.list` costs 1
quota unit per call and batches up to 50 video IDs, against a default 10,000 units/day. At
the user's production scale (67 channels, ~70 for estimation), even a full historical
backfill plus ongoing enrichment stays in the tens-to-low-hundreds of units/day — nowhere
near the daily cap. Making the API **optional** (not replacing RSS, not mandatory) resolves
the original setup-friction concern that justified the blanket ban: users who don't want to
deal with a Google Cloud project/API key simply don't set one, and the app behaves exactly
as it does today.

## Firm Scope
- YouTube Data API v3 as a purely additive, **optional** enrichment source for **duration
  only** — RSS-based discovery/ingestion (spec003) is untouched.
- New nullable `duration` column on `videos` (integer seconds), following the existing
  nullable-enrichment-column pattern already used for
  `youtubeChannels.possibleMissedVideosDetectedAt`.
- A periodic enrichment sweep, decoupled from the hourly RSS ingestion tick, queries videos
  with `duration IS NULL` in a not-yet-finalized status, batches up to 50 video IDs per
  `videos.list(part=contentDetails)` call, parses the ISO 8601 duration string
  (`PT15M33S`-style) into integer seconds, and writes it back.
- This single sweep mechanism covers **both** the one-time historical backfill (videos
  already in the DB) and ongoing enrichment of newly-ingested videos going forward — no
  separate backfill script/migration needed, since a freshly-ingested video also has
  `duration IS NULL` until the next sweep picks it up.
- Videos already `watched` or `ignored` are never targeted by the sweep, even if their
  duration is still null — applied uniformly (not just as a one-time backfill rule): once a
  video leaves the not-yet-finalized set before duration was ever fetched, it permanently
  has no duration. No reconciliation if a video later moves back to unwatched.
- `YOUTUBE_API_KEY` env var, unset by default — feature fully disabled, app behaves exactly
  as it does today. Follows the existing `AUTH_RECOVERY_PASSWORD` silent-skip-when-unset
  idiom (`src/lib/auth.ts`). Documented via the project's standard triple location
  (`.env.example`, `docs/DEPLOYMENT.md` config table) — no `devcontainer.json` default,
  since unlike the dev-only recovery password this is a real external credential.
- Missing/invalid key or API failures degrade gracefully: ingestion and the rest of the app
  are never blocked by an enrichment failure. Logged per spec028's structured-logging
  conventions, modeled on `rss.ts`'s count-based "some entries skipped" warn pattern rather
  than per-video error logs.
- UI: duration renders only when present, using the existing `row.field ? <span>...</span>
  : null` conditional idiom already used for `publishedAt`/`watchedAt`/`ignoreMethod` in
  `queue-list.tsx`.
- Amend `docs/app_idea.md` MVP item 4's "no YouTube Data API usage" constraint with an
  inline pointer to this feature's eventual spec, per `CLAUDE.md`'s product-spec-supersession
  convention — this feature directly reverses that documented tradeoff by making API usage
  opt-in rather than banning it outright.

## Nice-to-have / Stretch Scope
(none currently — see Explicitly Out of Scope for adjacent ideas deliberately deferred)

## Explicitly Out of Scope
- Any other `videos.list` fields (view count, statistics, etc.), even though they're free
  to fetch in the same call — duration only, per explicit scope decision.
- Reconciling a video that moves back from watched/ignored to unwatched after the sweep has
  already skipped it — never re-targeted; accepted as a one-time-per-video opportunity.
- `search.list` or any change to video *discovery* — RSS remains the sole discovery
  mechanism; the Data API is enrichment-only, bolted on after RSS has already found a video.
- Any admin UI/route for manually forcing a re-fetch of one video's duration.
- Using duration data for smarter behavior (duration-aware auto-Watching timers, Shorts
  detection — both mentioned adjacently in `docs/app_idea.md`) — this feature only adds the
  raw data and displays it; consuming it for smarter UX is a separate future feature.

## Related Specs / Code
- `docs/app_idea.md` MVP item 4 (no-API constraint) and its Ingestion Notes
  (no-duration-in-RSS limitation) — this feature supersedes both; needs the inline pointer
  per `CLAUDE.md`'s "Product spec" section once promoted to a spec.
- `docs/specs/003-scheduled-video-ingestion.md`, `src/lib/ingest.ts`, `src/lib/scheduler.ts`
  — existing RSS ingestion; stays untouched, new sweep is a decoupled parallel mechanism.
- `src/db/schema.ts` `videos` table — new nullable `duration` column, likely with a
  `duration IS NULL OR duration >= 0` check constraint matching the table's existing
  check-constraint pattern.
- `src/views/queue-list.tsx` (`videoCardBody`, per-row badge conditionals) — render hook for
  the new field; `src/views/watching-page.tsx` if duration should show there too.
- `docs/specs/028-structured-logging.md`, `src/lib/logger.ts` — logging conventions for
  degraded/missing-key states.
- `src/lib/auth.ts` `applyRecoveryPasswordFromEnv` — silent-skip-when-unset precedent for
  the new env var.
- `docs/DEPLOYMENT.md` config table, `.env.example` — where the new env var gets documented.

## Open Questions
None remaining — see Resolved Decisions.

## Resolved Decisions
- **Optional, not mandatory.** The RSS-only workflow must keep working unmodified with no
  key configured. *Why:* preserves the zero-setup-friction property that motivated the
  original MVP-4 ban; only reverses the "banned outright" part, not the "must be free to
  run" part.
- **Duration only, not other free API fields.** *Why:* explicit user scope call — avoid
  scope creep even though `statistics`/other `part`s would cost nothing extra per call.
- **Backfill/enrichment targets only not-yet-finalized videos** (excludes `watched` and
  `ignored`), applied as a standing rule, not just a one-time-backfill special case. *Why:*
  user's stated principle generalizes cleanly — no reason for ongoing enrichment to behave
  differently from the initial backfill.
- **No reconciliation for watched/ignored → unwatched transitions.** *Why:* user explicitly
  confirmed the backfill can be a genuine one-time process; added complexity isn't worth it
  for an edge case.
- **UI shows duration only when present, no placeholder for missing data.** *Why:* user's
  explicit UX call — matches the codebase's existing nullable-field conditional-render idiom.
- **API key via env var, unset = fully disabled, following `AUTH_RECOVERY_PASSWORD`'s
  silent-skip idiom.** *Why:* user's stated preference; also the only established precedent
  in the codebase for an optional external credential.
- **A single periodic sweep (not folded into `ingest.ts`'s per-channel upsert loop) handles
  both historical backfill and ongoing enrichment**, running as its own step, sequenced
  *after* each hourly ingestion tick completes (not an independently-timed parallel job).
  *Why:* `ingest.ts`/`scheduler.ts`'s per-channel, unbatched, sequential control flow has no
  natural point where multiple channels' newly-seen video IDs are simultaneously in memory
  to batch into one `videos.list` call — restructuring it to collect and batch would touch
  carefully reasoned error-isolation logic for marginal benefit, since duration is
  non-urgent enrichment data, not core ingestion. A sweep querying `duration IS NULL` is far
  less invasive and elegantly covers "new video never got a duration yet" and "old video
  never got a duration yet" with the same query. Running it after ingestion (same tick,
  sequenced) rather than on its own timer means freshly-ingested videos are eligible for
  the very next sweep pass, not up to an extra cycle behind.
- **Sweep processes eligible videos newest-first** (`ORDER BY publishedAt DESC` or
  equivalent), batched 50 IDs per `videos.list` call, working backwards through however many
  batches are needed to exhaust the eligible set each run. *Why:* user's explicit call —
  freshly-ingested videos should reliably get duration on the very next sweep rather than
  waiting behind a large historical backfill queue processed oldest-first; once the
  historical backlog is fully caught up, newest-first and oldest-first behave identically
  (nothing left to prioritize over), so this is a pure improvement with no downside once
  steady-state is reached.
- **Sweep target is `status IN (unwatched, watching)`, not `unwatched` alone.** *Why:*
  neither status represents a finalized video, and Continue Watching (which lists
  `watching`-status videos) benefits from duration the same way Queue does.
- **An auth-type failure (401/403) latches enrichment off for the rest of that process's
  uptime, logged once at `warn`; transient failures (network errors, 5xx) don't latch and
  are retried on the next sweep.** *Why:* avoids an obviously-bad key producing an identical
  warn-level log every single hour indefinitely, while not over-engineering handling for
  failures that are likely to self-resolve.
- **Duration renders as YouTube-style `M:SS` under an hour, `H:MM:SS` at/above an hour** (no
  leading zero on the leftmost unit — e.g. `5:33`, `1:02:15`). *Why:* matches the format
  users already recognize from YouTube itself.
- **A video ID YouTube's API doesn't return data for (deleted/private since RSS discovered
  it) is treated the same as a transient failure** — no duration written, retried on
  subsequent sweeps for as long as the video stays in the eligible status set, same as any
  other not-yet-successful case. *Why:* consistent with "retry until finalized or
  successful," and at this project's scale the wasted batch slot is negligible; no need for
  a separate give-up mechanism distinct from the watched/ignored exclusion that already
  bounds how long a video stays eligible.
- **A live-in-progress video's `contentDetails.duration` (YouTube returns `PT0S`/`P0D` for
  an ongoing livestream, since true duration isn't known yet) is treated as "no data yet,"
  not written as a literal `0`.** *Why:* follows directly from the already-agreed "duration
  only renders when a real value exists" principle — writing a literal 0 would render as
  `0:00`, which misrepresents an in-progress livestream as a zero-length video. Left null,
  it's retried on the next sweep after the stream ends and a real duration is available.
