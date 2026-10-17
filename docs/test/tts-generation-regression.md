# Text-to-speech and VoiceStudio regression

Use synthetic or explicitly authorized audio and isolated output directories.
Deterministic contracts prove routing, files and recovery; pronunciation,
reference-voice similarity and perceptual quality require a separately authorized
real-provider evaluation. Do not record credentials or private audio in evidence.

## Provider and model boundaries

- Configure a user-owned supported API key. Missing, expired, malformed and
  denied credentials fail clearly; recovery succeeds after explicit correction.
- Search/image/video/voice provider selection follows this build's public API-key
  policy. Model selection remains provider-owned where the settings expose only
  provider/key. No hosted account, quota, private credential sentinel or automatic
  managed fallback is introduced.
- Verify request shape, voice capabilities, input limits, format and error
  classification with controlled transport. Unknown voices, malformed references
  and rejected output do not become success. Cancellation makes no retry.

## Text, voice and file journeys

| User scenario | Independent outcome |
| --- | --- |
| Plain, long and multilingual narration | The requested text is covered once, in order; chunks do not lose or duplicate words. The returned audio is nonempty, decodable and has plausible duration. |
| Required subtitle/transcript sidecars | Text matches the requested source, cues are ordered and within audio duration, encoding survives reload, and unrelated branding or internal control text is absent. |
| Reference voice | Only explicitly supplied reference bytes are sent; invalid format, empty data, unavailable voice or provider rejection leaves an actionable failure. |
| Existing audio inspection | Duration, format and channel information come from the actual file. Silence, missing files and malformed bytes do not produce invented measurements. |
| Edit, extract, mix and transcribe | The requested operation runs through the owning audio capability; text-only requests do not accidentally create speech, and transcription does not silently invoke synthesis. |
| Multiple audio/text outputs | Each producer-declared file resolves to the delivered artifact; derived text and timing sidecars remain associated with their own audio. Repeated display does not duplicate publication. |
| Project and ordinary conversations | Equivalent source inputs produce equivalent valid artifacts in their authorized scope. Project data never leaks into the global scope or a different local user. |
| Interrupted or partial generation | A clear failure preserves accepted prior outputs and the user request. A later explicit retry remains usable; no duplicate charge/request or false final artifact appears. |
| Explicit single-operation request | Run only the requested operation. Preserve parameters and input ownership rather than adding an unsolicited multi-step workflow. |
| Paths and output visibility | Relative and absolute authorized source paths, non-ASCII names, spaces and project paths work; traversal, missing files and managed/private paths fail safely. |

## Validation layers

Run the owning audio, voice API, output-publication and VoiceStudio unit suites
through `npm run test:js`. Use real temporary artifacts and decode/inspect their
bytes, not only mocked success flags. Compare transcript coverage, cue boundaries,
file identity and retained output after failure.

A real provider canary additionally needs authorized test credentials and a
bounded input. Evaluate content/voice quality independently from API completion.
For each supported desktop platform, check native format/tool availability,
artifact preview, cancellation and restart. A pass on macOS does not establish
Windows or Linux behavior. Missing hardware/service evidence stays explicit.

Inspect all warnings, errors, retries and fallback. Logs retain only stable codes
and masked identifiers; keys, full local paths, source text and audio bytes must
remain absent. Hosted-account watermark and subscription scenarios are excluded;
ordinary audio/text artifact integrity remains covered.
