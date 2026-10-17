# Test infrastructure regression

This module follows `Common/docs/test-case-design.md`. Repository-wide claims
must be derived from the Git-owned and unignored source inventory, and the
discovery mechanism must have its own negative controls. A high file count is
not evidence of coverage.

## Automated evaluation matrix

| Core scenario | Expected result | Unit / contract evidence | E2E | Benchmark |
| --- | --- | --- | --- | --- |
| Production-module discovery | Every tracked or new unignored production artifact under the declared PC roots has an explicit product owner, including code, prompts, locale/data JSON, UI HTML/CSS, known vendored runtimes, built-in Agent/Skill content, launchers, manifests, icons and packaging assets | `test/main/quality/module-review-inventory.test.ts` exercises the real 925-artifact discovery plus synthetic unowned code/resource paths | Not applicable; this is repository infrastructure | Not applicable |
| Ignored/generated trees | Build caches, tests, fixtures, and missing files do not inflate the reviewed inventory; shipped vendored runtimes and their required fonts remain visible | The inventory test includes ignored `.build-cache`/test negative controls, a vendored-runtime positive control, and bounds the real artifact count | Not applicable | Not applicable |
| Discovery failure | A broken Git query or unexpected file-inspection error fails the suite instead of silently reporting an empty or partial inventory; only a real `ENOENT` disappearance race is skipped | Injected non-zero `git ls-files`, `ENOENT`, and `EACCES` results | Not applicable | Not applicable |
| Test entry discovery | New tracked or unignored tests and production-like data/build paths are not skipped by broad directory names | `test/main/util/check-line-endings.test.ts`, runner discovery contracts | Not applicable | Not applicable |
| Agent test-case policy loading | A repository agent must read the complete scenario-first policy in the current task before proposing, defining, reviewing, or changing cases, whether its runtime loads `CLAUDE.md` or `AGENTS.md` | `test/main/quality/test-case-design-policy.test.ts` checks both real entry points and uses apply-only wording plus a code-bounded policy as negative controls | Not applicable; this is an authoring-policy contract | Not applicable |
| Prompt-change governance | Prompt-facing commits declare an explicit audit; direct system-prompt and prompt-producing-code commits also carry confirmed scope, whether they enter through the local hook or pull-request CI | `test/main/quality/agent-engineering-contracts.test.ts` checks file/deletion coverage, producer-code detection, metadata parsing, hook wiring and CI wiring | Not applicable; this is a repository-governance contract | Not applicable |
| Git-hook setup | Repository paths are passed literally, missing Git/hooks remain a harmless no-op, and a locked config does not break dependency installation | `test/main/util/install-git-hooks.test.ts` injects all four outcomes | Not applicable | Not applicable |
| Staged language completeness | Locale-resource or language-registry edits run the existing Main/Renderer i18n cases for the full supported registry; failed cases block the commit. Unstaged validation inputs and inputs changed during checks are rejected, preserving unrelated work | `test/main/util/staged-i18n-gate.test.ts` exercises real Git/hook execution, incomplete translations, placeholder mismatch, partial staging, unavailable runtime and changed inputs; `test/main/i18n.test.ts` and `test/renderer/i18n.test.ts` own language semantics | Not applicable; local commit workflow | Not applicable |
| Windows CLI fixture runtime | A desktop test process that can see `git.exe` but resolves `bash` to the System32 WSL placeholder must still execute Git for Windows shell contracts; command fixtures with `.cmd` launchers must be invoked through their real Windows entry point | `test/main/util/test-runtime-env.test.ts`, the separately authorized model canary, and the separately authorized model canary | Not applicable | Not applicable |

