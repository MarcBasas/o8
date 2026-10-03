# Authored-intent admission — experimental first slice

Tracks [o8 #3185](https://github.com/hurttlocker/o8/issues/3185) under
[#3184](https://github.com/hurttlocker/o8/issues/3184). Thanks to Marquise for
helping define the continuity-first integration and to LavonTMCQ for the existing
handoff and worker-contract foundations. This preserves those systems unchanged.

## What is wired

`POST /api/orchestrator/intent-contract` accepts a raw authored HOTL 0.2 JSON
document, up to 128 KiB, from the existing operator principal only. It invokes
AODL's read-only JSON validator, checks the response's input digest and pinned
semantic revisions, then atomically publishes an immutable local record.
`GET` with `id` and `revision` reads that persisted record. Both responses are
`no-store`. Existing middleware remains unchanged; no device/worker capability
is added. The handler also refuses non-operator principals.

The feature is unavailable until the operator configures the desktop/server
process with `O8_AODL_PYTHON` (absolute Python executable), `O8_AODL_SOURCE_DIR`
(absolute full AODL checkout), and `O8_AODL_VALIDATOR_REVISION` (the 16-hex revision
returned by that checkout's `python3 -m aodl_contract.cli -V`). The checkout must
include [AODL #42](https://github.com/kvnloo/aodl/pull/42)'s JSON consumer. No
installation, model call, cloud service, or paid fallback occurs automatically.
Pin the checkout itself; the validator revision is not a complete supply-chain
attestation of the interpreter, catalog, or canonicalization implementation.

## Identity and persistence

The ref records `id`, `revision`, `sourceHash`, `semanticFingerprint`,
`validatorRevision`, and `inputSha256`. Provenance, raw input identity and semantic
identity remain separate. The hash comes from AODL, not a TypeScript reimplementation.

Records live under the existing `getDataDir()` in an `intent-contracts` directory.
A hash of `graphId` is used for the directory name. Each revision is written to a
private temporary file, synced, and published with a create-only hard link. A
concurrent different write cannot overwrite a revision; identical replay returns
the original record, including its creation time. Unsupported hard-link storage
fails rather than falling back to overwrite. This is restart-persistence work;
power-loss durability and hostile modification of the operator-owned data directory
are not certified here.

`aodl-canon-1` fingerprints the entire supplied document. This endpoint rejects
`plan`, `eventLog` and `observedGraph` rather than silently removing them from an
identity calculation. Runtime observations must be linked separately. Likewise,
Ripple's field names are not HOTL JSON paths: the later adapter must compile an
explicit supported projection, not insert new top-level fields into HOTL.

## What is deliberately not wired yet

This slice creates no mission, dispatches no worker, and changes no prompt,
approval, routing, handoff, or mobile behavior. A stored contract is data, not a
permission grant or proof of task success. It neither replaces nor modifies
`PacketTaskContract`. There is no automatic latest-revision pointer.

The next slice must bind an exact ref at mission admission, preserve it through
normalization/persistence/rerun, and expose it separately in worker prompts and
handoffs. That work must not treat a Python validation success as enforcement of
runtime budgets or authority. Ripple integration and the two-runtime stale-state
proof remain open acceptance items on #3185/#3186.

## Verification

`src/app/api/orchestrator/intent-contract/route.test.ts` drives the real route and
filesystem; only auth/data-root and the external validator boundary are fixtures.
It checks identical replay, conflicting/concurrent revisions, module reload,
auth loss during validation, bounded bodies, failure non-persistence and damaged
records. These tests do not establish canonical AODL semantics or real middleware
bearer acceptance; AODL's consumer subprocess tests and an installed-host check
are separate evidence.

Before upstream promotion, run the focused Vitest test, full `npx tsc --noEmit`,
`npm test`, touched ESLint and `npm run rule-check -- --base=<pinned-base>`, then
independently review the process/persistence/principal boundary. No installed-app
or two-harness continuity result is claimed by this first slice.
