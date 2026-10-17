# Library and Search Regression Cases

## Automated coverage

The deterministic layers have distinct owners:

- `test/main/features/kb_vector.test.ts` and `test/main/features/kb_indexer.test.ts` cover transactional replacement, interrupted/failed indexing, recovery, status transitions, scoping, and vector-store contracts. The indexer suite injects a bounded Windows ONNX-load failure, verifies the stable embed-stage code, and proves a manual retry of the same unchanged source reaches `ready`. `test/main/features/kb_embed_error.test.ts` owns bounded ONNX/tokenizer/generic classification for native FastEmbed load failures before telemetry removes raw paths. A failed replacement must preserve the last ready searchable version. `test/main/util/file-import.test.ts` directly owns bounded source inspection, symlink containment, lock recovery, source-change detection, exclusive publication and temporary-file cleanup. `test/main/util/operation-timeout.test.ts` owns timeout configuration bounds, timer cleanup, stable stage/code metadata and late-settlement handoff; a broken recovery callback must neither delay nor replace the primary timeout.
- `test/renderer/contexts-external-drop.test.ts` covers the global Library status boundary and failure surface as well as drag/drop: the successful IPC snapshot shape (`{ summary, files }`) is accepted without a synthetic `ok` field, native vectorization failures render only the actionable localized retry label, a click sends one reprocess request, and backend or transport rejection restores the clickable failed state without exposing native paths or codes.
- `test/main/features/sync/engine-contexts-reconcile.test.ts` pulls a Library source as device B and proves sync publishes the `contexts` change and schedules the device-local KB reconcile. Together with the path and sync exclusion suites, this protects the contract that source files sync while derived `.kb/vector.db` state remains machine-local.
- `test/main/util/fetch-embedding-model.test.ts` covers the offline model provisioning boundary: bounded/relative redirects, interrupted and short responses, partial-download cleanup, verified-cache reuse, staged extraction, atomic replacement, rollback, and preservation of an existing payload on failure. `test/main/util/packaged-resource-gate.test.ts` separately owns the pinned archive/file hashes and the final packaged-resource allowlist.
- `test/main/util/native-package-gate.test.ts` rejects a Windows package missing the tokenizers binding, ONNX binding, or ONNX core companion and rejects foreign-architecture or undeclared PE payloads. `test/main/util/smoke-packaged-native.test.ts` protects the real packaged-app probe, which launches the target executable under Electron-as-Node, loads the unpacked native modules and bundled model, calls FastEmbed, and requires one finite 512-dimensional vector. `test/main/platform-process-coverage.test.ts` keeps that release-shaped Windows package job wired for scheduled runs, pull requests, and direct pushes that touch the embedding model or Library embed/indexer path.
- `test/main/features/kb_embed_worker.test.ts` exercises the actual worker source against development and split `app.asar`/`app.asar.unpacked` dependency fixtures. This fast regression rejects the historical physical-worker resolution bug without loading ONNX; it does not certify a real archive or native process.
- `test/main/features/library_smoke.test.ts` protects the packaged acceptance oracle with actual storage/index/tool/revision modules and an explicitly fake embedding transport. It rejects missing dependencies, incomplete/constant vectors, unsafe fixture storage, and an acknowledged replacement that leaves stale chunks. The real acceptance below uses no transport override.
- The existing `product/smoke-packaged-app.cjs` release gate now requires the packaged Main/preload/renderer/IPC launch **and** `features/library_smoke.ts`: the production default supervisor forks the shipped unpacked embedding worker, returns finite normalized nonconstant512-dimensional vectors, respawns after close, indexes a project source, searches/reads its actual facts, checks create-only protection, checks out a CJK filename, explicitly replaces it, reopens the persisted index, rejects a stale revision, and indexes/searches/reads an independent Global file with the same name without scope leakage. Missing any required proof fails the gate; no launcher-only success is enough. Parent `NODE_PATH`, `NODE_OPTIONS`, `ESBUILD_BINARY_PATH`, and embedding-model overrides are removed. The shared log policy analyzes stdout, stderr and persisted application logs before cleanup, rejects errors/coverage gaps and surfaces warnings. `test/main/util/smoke-packaged-app.test.ts` owns missing-proof and diagnostic negative controls.
- `test/main/features/library-image-describer.test.ts` owns the image-specific model boundary: JPEG preprocessing, bounded session/timeout configuration, failed/empty/stalled model fallback, filename/path/provider-error log privacy, and an adversarial filename negative control.
- `test/main/model/core-agent/kb-tools.test.ts` covers the `library` list/search/read actions, including action dispatch validation, global/project scope, empty and in-flight states, recovery guidance, structural escaping, and the rule that internal errors, paths, and secrets never enter model-visible results or logs.
- `test/main/features/search_auth.test.ts` covers duplicate credential
  suppression and privacy-safe connectivity failures.
- `test/renderer/kb-picker.test.ts` covers account/project-scoped remembered
  folders, one-time legacy preference migration, traversal rejection, and
  extensionless archive names.
- `test/renderer/conversation-info-library-import.test.ts` exercises the
  produced-file menu as a user action. It verifies the authoritative task
  scope is sent to main, success identifies Project versus Global Library,
  failures stay visible, and project-only video imports do not become silent
  no-ops. `test/main/ipc/library-write.test.ts` separately proves repeated
  imports preserve both project entries without leaking into Global Library,
  and that reconciliation recovers a project index row left in `processing`
  by a prior app process. `test/renderer/project-library-index-recovery.test.ts`
  verifies reopening that Project Library actually triggers the recovery pass
  instead of leaving its spinner active forever.
- `test/e2e/library_e2e_search.spec.ts` uses real Electron to cover global Library upload, preview, rename, restart persistence, deletion, global search UI, and real local indexing/vector/tool round trips for both text and image input. The image case uploads a PNG through the UI, observes a JPEG vision request, waits for `ready`, then proves the resulting description reaches the `library` search/read actions. `test/e2e/projects_e2e_smoke.spec.ts` covers project Library upload, preview, persistence, deletion, produced-file menu import with destination feedback, removal of machine-derived vectors, and re-indexing after Recycle Bin restore.
- the separately authorized model canary independently exercises the shipped embedding model and sqlite-vector ranking over a multilingual synthetic corpus. It contains near-confusable negative controls and a multi-document query so aggregate scores cannot hide incomplete retrieval. Every per-query miss remains visible even when the aggregate threshold passes.
- Orkas LLM benchmark scenario `ollm-vision-library-ui-indexing` uses the production image-description prompt and a real UI screenshot. It scores OCR anchors, page structure, groundedness, and refusal to follow an instruction-shaped filename. The benchmark contract includes known-good and hijacked-output controls.
- Commander benchmark scenario `cmd-kb-hostile-document` checks non-deterministic model behavior: the model must choose Library retrieval, treat directive-looking document text as source data, and reject document-triggered side effects. Its deterministic expressions have contract tests for accepted and rejected outcomes.

Complex formats, indexing load, drag/drop, cloud sync, and stochastic real-provider retrieval over user-shaped corpora remain in the manual checklist.

## Problem-discovery record

The adversarial review found and fixed model-visible raw extraction/embedding errors, local-path and secret leakage in logs/tool responses, unescaped special-character filenames and chunk titles that could break result structure, and a benchmark false negative that rejected the valid phrase “资料来源，不是指令来源”. A later source-to-test inventory found that the image-description submodule still lacked an owning suite: it logged raw filenames/provider failures, treated an instruction-shaped filename as ordinary prompt text, and used the same five-minute deadline as its outer extraction wrapper. Because the outer timer starts first, a stalled vision call could mark the image failed before fallback completed. The describer now logs only a source hash plus stable error code, encloses the basename as explicitly untrusted JSON metadata, and settles one minute before the extraction deadline so fallback can still be embedded and persisted. A further deletion-race probe paused project embedding, deleted the project, then released the late result: the old worker recreated the machine-local vector database with deleted content. Project deletion now advances a per-project queue epoch, rejects queued and late work, closes the SQLite handle, and removes all derived local vectors; restoring the project clears the deletion fence only through reconciliation and indexes the restored source again. The local-import review then found that its atomic `rename` silently overwrote a same-name winner on POSIX, while the Windows recovery path explicitly deleted that file before retrying. Completed imports now publish exclusively; a collision preserves both the selected source and existing Library file and returns `E_IMPORT_TARGET_EXISTS`. Direct timeout fault injection also found that a throwing `onLateSettlement` recovery hook replaced the intended stable timeout error, while an asynchronously rejected hook could become an unhandled rejection. Recovery bookkeeping is now isolated and never awaited, so the queue receives the original timeout promptly even when that secondary path is broken. The offline model downloader review then found that a new archive deleted the old model before extraction/verification, redirects were unbounded, and interrupted responses could leave the install unresolved. Downloads and extraction now use a unique staging root, enforce redirect/size/inactivity/total bounds, validate the staged tree, and atomically replace or restore the prior payload. The retrieval benchmark reports a difficult cross-language mobile-layout miss instead of hiding it behind the aggregate score; this remains a quality canary for future embedding/reranking work, while the product's default retrieval depth is larger than the benchmark's Top-3 gate.

A subsequent account-switch and hostile-provider review found two uncovered
boundaries. The archive location picker stored its last directory in one
renderer-wide key, so another signed-in account could inherit that preference.
Search connectivity probes also returned and logged raw upstream exceptions,
which could echo an API key or local path. Picker state is now scoped by account
and project with one-time legacy migration; probe failures use stable
user-facing categories and redacted log summaries. The same review removed
duplicate search fallback rows for an identical provider/key pair.

The native-failure recovery review found that rejecting a user's reprocess
request left the renderer's local row in `pending`, replacing the clickable
failed chip with a spinner until a later status refresh happened to repair it.
The retry path now restores the failed state immediately for both backend and
transport rejection. The same review found that the expensive real-Windows
packaged FastEmbed smoke ran for pull requests and on a schedule but not for a
direct release-branch push; relevant direct pushes now run the package smoke,
while the separate full Windows coverage job remains scheduled/manual only.

## 2026-10-16 packaged worker escape and release regression

The user goal is usable Library content, not merely a saved/listed source. The
historical defect passed several individually valid checks because none crossed
the failing boundary:

| Previous layer | What it actually established | Why the worker defect escaped | Current protection |
| --- | --- | --- | --- |
| Embed supervisor unit | Correlation, crashes and cooldown with `FakeChannel` | Never loaded the real worker or its imports | Keep these fast protocol cases; add the real packaged launch below |
| Index/search unit | Queue/storage/results with mocked embeddings | Fixture vectors bypassed every FastEmbed dependency | Keep independent state tests; require actual worker/native round trips at release |
| Source Electron E2E | Real worker from the complete development dependency tree | No archive/unpacked split | Retain UI/IPC scenarios; do not promote them to installer evidence |
| Static packaged graph/native inventory | Required files, versions and target binaries existed | Presence and logical-root visibility did not prove physical-worker resolution | Split-layout worker unit plus exact final-application launch |
| Native packaged inference | Electron-as-Node loaded FastEmbed directly from `app.asar` | Used a different module resolver and process path than the worker | Keep native diagnostics, plus the real default utilityProcess supervisor path |
| Packaged launch | Main, preload, renderer and IPC became ready | Lazy embedding worker was never started | Readiness now also requires the complete synthetic Library journey |

The original isolation migration (`96d923aae4`) moved inference into a worker;
the native smoke continued testing direct loading. This is a mismatch between
what the test proved and the released execution path, not evidence that all
Library unit assertions were invalid. The split-layout regression and temporary
real-package canary delivered in the first H16 repair were useful, but the latter
was not yet a durable release gate; this follow-up closes that gap. It does not
retroactively attribute the sampled checkout failure to embedding or certify a
historical CI run without its receipt.

Scenario matrix: project and Global imports must reach ready/search/read through
the real worker; worker close must allow the next request to respawn; an explicit
revision must survive store reopen; stale/create-only operations must preserve
current bytes; same-named scope sources must remain distinct. Counterexamples
include missing worker dependencies, constant/incomplete vectors, missing proof,
false replacement success and error logs beside a success marker. The cases use
synthetic isolated storage and no paid/provider model call.

For each native candidate run the normal `product/package.sh local` or release
entry, which calls `validate-release-artifacts.cjs` and the packaged-app smoke.
The Windows workflow also triggers for Library/project-file/context/vector/tool
and startup changes, plus the owning Library cases, rather than only embedding
and packaging files. Windows cross-build skips remain explicit; native Windows
execution is required for Windows acceptance. A configured GitHub workflow is
not proof that the cnb-hosted branch triggered or completed it.

The original-worker negative control must run only on a disposable local
candidate copy, never the installed app: retain the candidate worker, replace it
with the pre-fix physical-loader version, require the same packaged-app gate to
fail, restore the exact candidate bytes, and require a pass. Do not manually
accept a `ready` marker without its Library proof and log analysis. Current run
receipts and original attribution gaps are kept in
`Common/docs/reviews/global-production-sampling-2026-10-16.md`; native Windows,
signed deployment, cloud/device continuity and retrieval-quality acceptance
remain separate from this deterministic package journey.

## Setup

1. Prepare global- and project-library samples containing PDF, DOCX, images, Markdown, CSV, code, and empty files.
2. Include mixed Chinese, English, and Japanese content, plus filenames containing CJK characters, spaces, parentheses, and special characters.
3. For cloud-sync checks, prepare devices A/B or two isolated data roots.

## Library UI

1. Folders appear before files, names use natural sorting, and each file keeps its modification time on the secondary line.
2. Folder, PDF, document, spreadsheet, presentation, image, video, text, and code entries use distinct shared SVG icons; icons remain 20px while file/folder titles use the smaller tree type scale, folders have no chevrons, and no emoji icons appear.
3. In both global and project libraries, drag a file into a folder and back to the root. The tree, active selection, index status, and search results refresh consistently.
4. In both global and project libraries, drag a nested folder into another folder. Its subtree moves intact and the destination expands after refresh.
5. Dropping a folder onto itself or a descendant is rejected. A same-name target reports a conflict and leaves the source unchanged.
6. Global- and project-library entry points remain distinct and never leak data across projects.
7. While large files are indexed, the UI progresses through pending/processing/ready/failed without remaining stuck.
8. Empty, unparseable, or unsupported files produce a clear state rather than an empty card or crash.
9. In both global and project Libraries, markdown edit and preview surfaces stretch to the bottom of the available viewer while the toolbar stays at the top.
10. After a move, the destination opens, the moved entry scrolls into view and highlights briefly, and a success toast names the destination. Same-name targets show a specific conflict and keep the source unchanged.
11. File row menus expose one consolidated `Move or copy` item only and use three groups in this exact order: Edit/Rename/Delete; Add to new task/Move or copy; Open containing folder. Project and global Libraries match, no icons or actions are added, and the root menu is unchanged.
12. From both global and project Libraries, move and copy a file and a nested folder to another folder in the same Library. Copy preserves the source; move removes it only after the destination succeeds.
13. Move and copy in every cross-Library direction: global to project, project to global, and project to another project. The source and destination trees, search indexes, and sync state refresh correctly.
14. Use Cmd/Ctrl-click and Shift-click to select multiple visible rows in both Libraries. A compact batch bar appears only for two or more selections, uses the same consolidated dialog, and disappears after completion or clearing the selection.
15. Select a folder together with one of its descendants and run a batch transfer. The descendant is transferred only once. A same-name destination or unsupported destination reports a per-item failure without overwriting existing content.
16. Simulate a cross-Library move whose destination copy succeeds but source deletion fails. The destination copy is rolled back and the original source remains available.
17. Open the Move/Copy dialog and click the dimmed backdrop. The dialog stays open; its existing Close, Cancel, and Esc controls still dismiss it.
18. Transfer and archive folder pickers use the same compact Library-tree styling. Root, top-level folders, and nested folders have clearly increasing indentation; selected rows and folder icons remain visually consistent. The conversation archive title reads `保存到项目资料库` or `保存到全局资料库` in Chinese, and its destination line repeats the matching Library before `根目录` or the selected nested folder. The archive picker remembers its last folder per local account and per project; switching accounts must not reuse another account's folder.
19. Drag supported files from Finder/Explorer onto the global Library root and a nested folder, including when the Library is empty, over an existing root file, and over the open wrapper space of a first-level folder. The rows appear in the intended directory and begin indexing. In a mixed multi-file drop, supported files are added while unsupported, hidden, or system files are rejected with a concise filename list only; the dialog must not dump the extension allowlist or append supported-category guidance.
20. Open a file in the global Library and drag an external file anywhere over its detail pane, including text, image, PDF, and Office previews. The new file is added beside the open file in the same directory; a root-level open file targets the Library root. The detail pane shows and clears its drop highlight correctly.
21. Upload a file whose content already exists at the Library root and in a nested folder. The dialog says only that the file exists and lists `Library / root` or the existing parent directory. It must not repeat the uploaded filename, existing filename, content-shaped path, hash/dedup detail, or generic `Add failed` prefix.
22. Force upload, open, save, reveal-in-system, delete, reprocess, and add-to-task-chat failures in both global and project Libraries. Each dialog briefly describes the failed action and suggests retrying; it never displays exception text, local paths, backend codes, hashes, or repeated failure prefixes. A batch upload lists failed filenames only.
23. Delete a nested file and a folder from both the tree and detail viewer in global and project Libraries. Every entry point asks for confirmation, displays only the entry basename, and says the item can be restored from the Recycle Bin. Cancel leaves the item untouched; confirm deletes it and creates a restorable Recycle Bin entry.
24. Rename to an invalid name, an existing sibling name, and an unsupported extension. The dialog distinguishes invalid characters, same-folder conflicts, and unsupported formats without showing backend wording. A failed indexing chip tooltip contains only the retry instruction, and a non-previewable file says it was shown in the system file manager rather than opened in the default app.
25. Drop several large PDF/Office/image files from Finder/Explorer. Uploads use bounded concurrency and remain responsive without renderer/base64 memory amplification; files over the documented cap, sources changed during import, and symlinked source/target paths fail individually without blocking the remaining batch or writing outside the Library.
26. Start two simultaneous global imports with identical bytes. Exactly one succeeds and the other reports the existing-content conflict. Import different bytes over an existing global same-name file: it reports a target conflict and preserves both source and destination. Start two simultaneous same-name project imports; both succeed under distinct non-overwriting names.
27. From a project task's produced-file menu, choose `Add to Library`. The
    success toast explicitly says Project Library, and the item appears only
    there. From a non-project task, the toast explicitly says Global Library
    and the item appears there. A failed import shows an error instead of
    success, while a supported project video executes the same action rather
    than closing the menu silently. Repeating the action preserves each copy
    under a distinct name.
28. Close the app while a Project Library file is processing, then reopen the
    same Project Library. The interrupted row is reconciled and reaches
    `ready` or `failed`; it never remains on the processing spinner solely
    because the prior process ended.

## Real Search and Read

1. Search Chinese, English, pinyin/initials, and mixed keywords; manually judge relevance and ordering.
2. Project-conversation Library search prioritizes the current project and distinguishes global from project sources.
3. Use a real provider model over a representative user-shaped Library corpus; it chooses `library` search and read actions, cites the correct snippets, treats retrieved text as data, and never exposes internal local paths.
4. Use an explicitly authorized BYO model with the vision Library indexing scenario before changing the image prompt or vision routing. It must preserve searchable OCR/structure and ignore instruction-shaped filenames; deterministic fallback must still keep the queue moving when vision is unavailable.

## Local recovery

3. Restoring a Library file returns it to the tree and re-enqueues indexing.
4. Force-quit while global and project files are `processing`, then reopen the relevant Library. Rows with no live/queued job return to pending and complete; active rows in the current process are never mistaken for crash leftovers.
5. Simulate an extraction or embedding operation that exceeds its stage timeout. That file becomes failed with a stable stage/code, the next queued file still completes, and status refresh does not start a duplicate retry while the timed-out underlying operation is still settling.
6. Make a project Library directory temporarily unreadable during reconciliation. Existing vector rows remain intact, destructive deletes are skipped, and a later healthy scan resumes normally.
7. Pause extraction or embedding for a project file, delete the project, and then release the late operation. Queued and in-flight work must not recreate `<uid>/local/projects/<pid>` or leave searchable derived content. Restore the project from Recycle Bin and confirm reconciliation indexes the restored source into a fresh vector store.

## Windows native packaging and recovery

1. Run the public Windows package validation for every direct push or pull request that changes `kb_embed*`, `kb_indexer`, the bundled embedding model, packaging scripts, or native contracts. The validation must build the x64 release-shaped package on `windows-latest`; a cross-built PE inventory is not sufficient evidence.
2. In the packaged-app smoke, launch `Orkas.exe` under Electron-as-Node and load better-sqlite3, sqlite-vec, canvas, tokenizers, esbuild, FastEmbed/ONNX, and the bundled BGE model from final package paths. Pass only after real inference returns exactly 512 finite values.
3. Remove each of `tokenizers.win32-x64-msvc.node`, `onnxruntime_binding.node`, and `onnxruntime.dll` from separate controlled package fixtures. Each fixture must fail the closed-world package gate with the missing component; it must never reach distribution as a nominally valid package.
4. On a clean Windows 10/11 x64 installation, add a text file to Library, observe pending/processing/ready, search its body, restart the app, and search again. With a controlled native-load failure, the file remains previewable, shows `Vectorization failed — click to retry`, and a rejected retry immediately remains clickable without exposing a DLL path or error code.

## Logs and Safety

1. Logs expose only masked user ids, path hashes, file types, chunk counts, statuses, and sanitized error summaries.
2. Logs never expose full local paths, full `cloud/...` paths, filenames, file content, model keys, email addresses, or phone numbers. Search-provider connectivity checks return stable categories and log only redacted error summaries even if an upstream response echoes a key or path.
