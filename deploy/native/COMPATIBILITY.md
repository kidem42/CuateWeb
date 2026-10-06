# Hermes compatibility and provenance

Hermes owns session IDs, messages, runtime model selection and file paths. The web
server is an authenticated adapter to the existing APIs, not a synchronization
service. Native approval support is supplied by the existing Cuate gateway patch v6;
CuateWeb ships no separate server patch. See `../hermes/README.md`.

- API: session listing/creation, oldest-first paginated messages, rename/pin/delete,
  model options and locks, native session SSE, run status, confirmed stop and steer.
- Files: Dashboard multipart upload and authenticated download. Originals remain on
  the Hermes host; attachment notes use the existing Cuate wire format. Supported
  image formats also send a bounded image part to the model.
- Speech input: disabled in the Hermes composer until an STT integration is available.
- Context: native `context_used`/`context_max` and source/estimate flags first;
  legacy Cuate patch `context_tokens`/`context_window` otherwise. Usage totals never substitute for context occupancy; the minimal UI shows the
  native occupancy in the standard context gauge when Hermes supplies it.
- Local browser metadata remembers observed run IDs and occupancy by user,
  connection and session. It is not a canonical transcript store.
- Existing LibreChat conversations and features retain their own upstream routes.

Hermes uses the standard conversation list, header/model selector, message rows,
composer, Steer, Stop and approval controls. Older `/hermes/...` links redirect to
the same native session in `/c/...`. Unsupported edit/regenerate/branch actions
are hidden. Delete uses the native session DELETE operation; there is no separate
archive or Mongo transcript copy. Confirmed deletion retires local run recovery.

## Files, approvals and background continuation

- Remote result paths use the standard file preview dialog and authenticated
  Dashboard downloads. The shared viewer supports its existing preview formats;
  unsupported formats remain downloadable. Raw HTML is returned as plain text.
- The stock attachment button, paste and drop use native upload. Sending waits
  for uploads; attachments from another session cannot be sent accidentally.
- The standard `/` picker (with `$` also accepted) and Skills sidebar read the same Hermes skill catalog. Selection inserts an
  explicit user instruction naming the skill; it does not claim deterministic
  server-side skill preloading or enable LibreChat agent/MCP tools.
- `approval.request` events and known-run status restore individual approval
  cards. Allow once / Deny posts the exact `request_id` and `choice` to the existing
  run approval endpoint. Continuation consent never approves an agent tool.
- Background delivery rows offer Continue once / Not now, with Continue still reachable after deferral.
  Session consent is scoped to the account, configured Hermes API URL and session.
  The client rechecks the known run and fresh history before continuing, rejects
  superseded deliveries, and records consumed row IDs before posting. An uncertain
  response is never replayed automatically. Stop revokes automatic continuation.
- A runtime in the authenticated application shell keeps observing previously
  opened sessions when the user changes pages. Closing all browser tabs stops
  client-side continuation decisions, as quitting a native client does; the
  Hermes run itself is not cancelled by a browser disconnect. Reopening restores
  observed run IDs and decisions. This is browser metadata, not a new sync service.
- Same-browser automatic continuation uses Web Locks when available. Hermes has
  no atomic cross-device continuation-claim endpoint: two different devices can
  race after their preflights. This preserves the existing native limitation and
  does not claim exactly-once delivery across devices.
- While Stop or an unconfirmed run is pending, the draft stays in the composer.
  No new turn is silently sent. An error before receiving a run ID cannot be
  resolved authoritatively by a session-wide run listing (Hermes supplies none);
  inspect the native history/run status before considering a manual resend.

### Gateway approval prerequisite

Use the checked Cuate gateway patch v6 or a compatible upstream implementation.
The authoritative `approvals` array restores all pending requests, including
removal after a decision from another client. `approval.changed` triggers a fresh
status read. A singular legacy field is accepted as a fallback only.

The retired standalone CuateWeb bridge is not sufficient: notifier registration
alone does not address Hermes' unattended/native presence gate or multiple pending
requests. Do not deploy it from the September 16 archives. See `../hermes/README.md`
for the canonical installation boundary. No Cuate patch sources are copied here.

## VPS acceptance

1. Log in as an assigned account; an unassigned account must not see the connection.
2. Continue one session alternately in Cuate and the browser; verify model selection,
   attachments, pagination and current context occupancy.
3. Preview and download a result document and an image; upload a file; the microphone is intentionally unavailable.
4. Trigger a real approval request on a compatible gateway; approve/deny precisely
   that request, then reload while another approval is pending.
5. Receive a background result: exercise once/later, navigate away and back,
   and verify Stop revokes consent and unsent text remains in the composer.
6. Disconnect/reload during a turn; verify run recovery and no automatic paid retry.

These client/server contracts have automated isolated tests. The application and
live VPS have not been launched automatically; installed-server acceptance remains
the maintainer's test, including the gateway prerequisite above.

## Contract revision checked on 2026-09-16

[Hermes PR 87418](https://github.com/NousResearch/hermes-agent/pull/87418) was open,
not merged, at head `d867abff3ee755abc79f3277d9fd436a457b67ff`. Its current fields are
`context_used`, `context_max`, `context_percent`, `context_source` and
`context_estimated`, not the original legacy names. It reports anchored occupancy
and distinguishes cost counters. The client accepts both revisions without
changing the gateway. It does not assert which revision a user's VPS is running.

## Hermes 0.21.5 (`v2026.9.24`) checked on 2026-10-06

Checked against the tagged source. The HTTP routes are unchanged from 0.21.3. New
session-stream events (`assistant.commentary`, `run.queued`, `hermes.status`) are
ignored by this client, as before. Gateway reports written as user rows now also
include the early `[ASYNC DELEGATION TASK FAILED …]` warning and the gateway's
consolidated `[IMPORTANT: N background … completed …]` batches. Both render as
service reports. A delegation unit is pending until its own `COMPLETE` or
`BATCH COMPLETE` report arrives, including one inside a consolidated row; an
early task failure does not finish it. The continuation turn is sent framed as
`<cuate-continuation>…</cuate-continuation>` and is shown as a marker. Unframed
prompts from older clients are still recognized.

## Licensing boundary

Upstream LibreChat license files and attribution remain intact. This adapter was
implemented here from the API contracts; native Cuate implementation files and
its gateway patch code are not bundled into LibreChat. Hermes remains a separately
installed service. This does not change Cuate's license or require it to become a
LibreChat derivative.

The repository's root MIT license is not a license declaration for every dependency
or optional service. Upstream package manifests also contain ISC declarations;
MongoDB and the optional admin-panel service have their own terms. Retain component
notices when distributing. The dependency lockfile pins the code used by this test
bundle; this work is not a completed legal/provenance audit of the entire upstream
stack and does not assign a new license to third-party code.

## Transcript formatting and opening history

Native sessions use the shared chat's bottom-landing behavior, once after the
opened transcript mounts. Reading older messages does not re-trigger landing.
Set `hermes.formattingInstructions: true` to send Cuate display instructions on
the first accepted ordinary user turn per session (default false for existing
configurations; installation examples enable it). Slash commands, steering and
automatic continuation do not acquire a formatting prefix. The existing
`<cuate-briefing>` history marker from another Cuate client prevents duplication;
its complete leading block is hidden in user message presentation. The local
acknowledgment marker is scoped to user, endpoint identity and session.
HTML/Markdown document fences use stock artifact cards and preview/download UI;
Mermaid and ordinary Markdown retain their existing renderers. No Gateway or
Hermes history migration is required.

Native file links share the normal file-preview dialog. Markdown files use the
shared Markdown renderer, images use object-URL previews, HTML files use the
stock artifact sandbox, and PDF retains the existing viewer. Copying and
original-file downloading remain separate actions. Native Markdown image paths
(`sandbox:/...`, absolute paths and `~/...`) are read through the assigned Hermes
file API; object URLs are revoked on replacement/unmount. Relative image paths
without an attachment mapping are not resolved against an inferred server directory.

Create and rename requests validate the native 100-Unicode-character title
limit. Titles derived from a first message are clipped before creating the
session, preserving the full message for the subsequent chat request.

Native tool history is projected into the stock tool-call disclosure UI. Results
are joined to preceding calls by exact tool_call_id within a user turn, including
parallel calls and empty results. Completed outputs are not separate chat messages.
Unmatched results (for example at a truncated history boundary) remain available
in the same accumulated step journal. Original Hermes records and IDs are not rewritten.

Native assistant stretches share one reply shell: prose retains its order and tool
calls accumulate in a collapsed `Steps` group below it. Real user turns, recovered
steers and service deliveries delimit groups. Unknown tool outcomes remain unknown,
rather than being labelled cancelled. Group expansion survives history polling.
Delegation and process deliveries use collapsed stock Wakeup cards on the assistant
side, with separately expandable task details. Unknown report content is retained.
Compression metadata is excluded from presentation while genuine merged user text
and attachments survive. Complete out-of-band steer envelopes restore user rows;
the raw history still drives independent continuation and action-approval consent.

Native `md` fences and complete HTML detected without an explicit language use the
existing artifact viewer. Attachment-note paths reuse the authenticated file viewer.
Desktop-specific Finder/open-in-local-app actions are not emulated in the browser.


## Session files and terminal provider failures

The native chat header's folder opens file references from the loaded session
history, separating assistant deliveries from user attachment notes, newest first.
It reuses stock dialogs, the existing file preview and original-byte download.
Directory listings use the same scoped Dashboard connection and are fetched only
while the folder is open. Missing entries are disabled; a failed availability
check stays distinct from confirmed absence and still allows an explicit download.
Refresh rechecks cached listings. This is not a filesystem-wide browser or a new
file-retention store. Relative filenames without an authoritative path are not
resolved against a guessed server directory.

The native session stream emits `error` followed by `done` when a provider call
throws. The client treats this as terminal failure, disables automatic follow-up,
and does not repeat the message. Known failed runs are reconciled after reopening,
so an old user-only tail does not keep model selection locked. A newer external
turn remains busy. A provider model-not-found error prompts an explicit model
choice; catalog presence alone does not prove provider availability.

Native assistant file references, including paths in inline code, also expose
preview links below the reply. Markdown uses the existing renderer; HTML uses the
existing isolated artifact preview. No server directory is exposed as a public URL.

SSE optional fields accept native null values (including tool args/preview), so
a valid tool event does not abort the response reader. A subsequently confirmed
completed run clears the stale uncertain-send notice without another POST.
Steer framing is owned by the server adapter exactly once; the browser sends the
original addendum and requires explicit acceptance before clearing its draft.

Native MEDIA:/absolute/path deliveries are recognized by the same collection
used for reply file chips and the session folder. Quoted paths and extensionless
files are supported. Download eligibility does not depend on preview support or
a file-extension allowlist. External URLs and relative paths are not reinterpreted
as paths on the Hermes host.

Selecting a native skill requests its full SKILL.md through the configured
Dashboard GET /api/skills/content?name= endpoint. The adapter retains connection
scope and owner checks and uses the separate Dashboard credentials. The skill
panel reuses Markdown rendering and the source/view toggle with explicit retry.
The short catalog description remains the summary, not the full skill body.

New native sessions reuse the last explicitly selected provider/model pair in
this browser, scoped to the authenticated user and configured endpoint identity.
Only an acknowledged existing-session model change updates this preference.
Reopening an older session does not overwrite it or change that session's model.
No unavailable saved model is silently replaced with the Gateway default.

An explicit model choice is confirmed at native session creation with
`require_model_lock: true`, so the first turn uses the remembered provider/model.
External user/assistant exchanges clear inferred activity rather than starting
a growth hold for the completed reply. Known active runs retain authoritative
run-status handling; assistant-only progress retains the grace period.
