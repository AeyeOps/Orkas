# Application regression

Use temporary local user data and synthetic inputs. Confirm visible outcomes,
retained file/database bytes and absence of refused side effects. A successful
fixture does not establish model output quality or live third-party availability.

## Automated entry points

- `npm run test:js -- test/main/features/saved_apps.test.ts test/main/features/chat_artifacts.test.ts test/main/features/saved-app-type-recovery.test.ts test/main/features/web-app-commercial-entry.test.ts test/main/features/web_apps.test.ts test/renderer/saved-apps-journeys.test.ts test/renderer/commercial-entry.test.ts` covers feature, SDK and interaction contracts.
- Run `npm run test:e2e:typecheck` before `npm run test:e2e -- test/e2e/saved_apps_e2e_lifecycle.spec.ts`.
- Run `npm run test:apps:e2e` for the selected local application journeys.
- Review the actual logs, warnings, fallback and cleanup failures. Intentional
  damaged-metadata, interrupted-write and denied-capability cases are negative
  controls; an unrelated warning remains a failure to investigate.

## Commercial web application entry

1. Activate the Web apps tab or the Web app creation option. The commercial
   guidance appears before any conversation, model request, artifact, preview
   or runtime instance is created. Cancel/Escape preserve the current local
   view, draft and focus. Verify Chinese and English at normal and narrow sizes.
2. Only an explicit Download action opens the official localized download URL.
   An opener failure remains recoverable; cancel, page load and repeated model
   failures never open the browser automatically.
3. Direct IPC and tool requests for `web` or legacy `cloud` return the specific
   `E_COMMERCIAL_REQUIRED` / `web_apps` receipt. Tool results are errors and keep
   the receipt intact. A localized, nonblocking chat notice provides the download
   action, once per turn, without relying on the model's wording.
4. Retained web metadata, structured task bindings and edit snapshots remain
   authoritative when a caller omits type or claims local. Save, update, edit,
   preview, SDK and direct resource requests cannot execute that web source.
   Compare all original files, metadata, databases and journals before/after,
   including restart and background cleanup. They must remain unchanged.
5. Corrupt/unreadable binding metadata cannot become local permission. Genuine
   legacy local fallback remains available. Ordinary HTML, website authoring
   and external resources in an authorized local application remain usable.

## Local creation, list and save

- Create from an idea or template once, preserving literal user text. A second
  click does not duplicate the task. Sending failure keeps the recoverable draft.
  Cancel/backdrop/Escape retain a session draft; a reset clears it.
- The list uses local metadata, preserves cards after a failed/malformed refresh,
  rejects a late stale listing after deletion, and confirms a genuine empty list.
  Counts, type controls, menus and long titles remain stable at narrow widths.
- Save an artifact and a complete file bundle, including a non-index entry,
  CSS/module/JSON/font/audio assets, binary content and ordinary long paths.
  Reject traversal, hidden/managed paths, symlinks, invalid encoding and oversized
  input before changing the destination. A workspace-root entry requires its own
  folder. Show one confirmation after an actual successful save.
- Omitted or null type in an ordinary task retains local compatibility; conflicting
  types in a bound edit fail before writes. Saving a valid independent local copy
  must not overwrite its original or silently change identity.

## Open, edit and recovery

- Open a local card with mouse, Enter and Space. One action opens one preview;
  rename preserves identity and icon. Refresh/restart retain the saved result.
- Editing creates a source-attached task with the exact original identity and
  fingerprint. Conflicting source changes require an explicit recovery choice;
  repeated or interrupted commits do not lose the original or duplicate data.
- Exercise each save-journal crash point and cleanup failure. Recovery retains a
  usable source and only commits a complete replacement. Missing/damaged edit
  context produces a recoverable failure rather than an invented local binding.
- File/Artifacts views and chat cards navigate to the correct artifact and user.
  Source attachments, generated files and current composer state remain isolated.

## Shared local SDK and SQLite

- Discover actual schemas, enforce manifest declarations and reject undeclared
  capabilities before native, model or connector execution. Ordinary local calls
  remain available without introducing additional paid routing or approvals.
- Preserve record values, not just counts, through reopen. Preview records are
  temporary and never overwrite formal data. App copies and local users remain
  isolated. Concurrent startup, timeout and worker closure permit later recovery.
- Run the independent common-data fixtures: field/type/size constraints, read
  filters, stable pages, aggregation, relations, capacity and idempotent insert.
  Reusing an operation ID with different data fails without corrupting records.
- Cancellation, frame removal, account change, stream-consumer departure and
  revocation terminate the owned request. Late results cannot write or publish
  into a replacement frame; an explicit new request can succeed. Completed
  external effects are not undone or replayed automatically.
- Exercise partial reads, binary exports, create-only writes, storage aliases,
  denied path access, deep paths, long keys and exhaustion/reopen boundaries.

## Rename, delete, localization and privacy

- Rename changes only the display name; original/source identity survives.
  Delete confirmation names the app and irreversible local records/private files.
  Cancel has initial focus and preserves data; success removes the card only
  after backend confirmation. Failure keeps the card and permits retry.
- Check card dates, exact edit draft, app-type tags and failure copy in every
  registered language. No untranslated key, private path or backend text appears
  in alerts. Long names and RTL layouts retain accessible buttons and local scroll.
- Hosted publication, online data management and personal synchronization are
  unavailable. Their execution/recovery journeys are outside this build; the
  retained entry only explains how to obtain the commercial version.
