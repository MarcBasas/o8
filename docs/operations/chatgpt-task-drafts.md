# ChatGPT task draft preparation

Related work: #3249. This increment prepares inspectable local task drafts. It
does not create a mission, packet, workspace, queue entry or worker session.
Source acceptance and hosted/installed acceptance are separate.

## Capability boundary

The new local tools are `o8_task_options` and `o8_prepare_task`. Both require the
separate `o8:prepare-task` scope and a relay-verified account subject carried in
the signed one-minute local capability. Its expiry cannot exceed the original
OAuth grant expiry. Existing read and follow-up grants gain no permission.

The production relay manifest, Clerk scopes and public directory package are
unchanged. `TASK_DRAFT_TOOLS` is a dormant local schema export, deliberately
separate from the production `PLUGIN_TOOLS` listing. Provisioning this scope,
updating the relay and activating production are later operator gates.

Preparation verifies an unexpired, signed desktop license against the relay
account, the current active identity and a durable sign-in epoch. Any persisted
sign-out marker holds the request. Identity is checked again after asynchronous
work, before persistence and before returning a receipt. No offline grace,
decoded identity, CLI profile or caller-supplied account substitutes for this
verification.

## Snapshot and contract

First call `o8_task_options` with the selected machine to list registered
repository and canonical project IDs. Then supply both IDs to capture a
five-minute snapshot. The server resolves the local path; callers cannot provide
one. A snapshot binds account, client, machine, session epoch, repository,
canonical project, exact Git revision, a clean workspace and current rule digest.
The digest includes tracked nested AGENTS/CLAUDE files, root instruction files,
local dispatch rules and the global AGENTS contract.

Runtime/model/effort entries come from the current registries. They are catalog
metadata, not proof of installation, account availability or execution.

`o8_prepare_task` requires that snapshot, a normalized objective, exact existing
relative files, a canonical sealed requirement contract, requested evidence and
explicit compatible runtime/model/concrete effort pins. The initial work mode
is read-only; only runtimes with the existing read-only adapter path are accepted.
File traversal, symlinks, environment files, scope overrides, unknown fields,
unsupported routing and unresolved/coerced effort are refused. Evidence and
verification text are stored as data; the preparation path executes none of it.

The workspace, membership and rules are checked fresh before persistence.
Changed revisions/rules, dirty repositories and expired snapshots hold
preparation. The sealed contract's mapped files must match the selected files.

## Durable receipt and local inspection

The protected `plugin-task-drafts` store contains one immutable intent/receipt
record for each account/client/machine/idempotency key. A canonical contract
digest binds exact arguments permanently; records and bindings do not expire
after the ordinary ten-minute idempotency window. Exact retries return the same
task ID, including after snapshot expiry or process restart. Changed arguments
conflict. Current account authorization still precedes receipt disclosure.

Cross-process key locks serialize publication. The intent and receipt are
published together by atomic rename after file sync, then directory sync.
A durable record is recoverable even if its writer died before removing its
lock. A lock without a record stays held; preparation never guesses that it is
stale or launches a second worker. A local operator must inspect an uncertain
lock before recovery.

Successful receipts say `state: held`, `executionEnabled: false`,
`dispatched: false` and `completed: false`. The declared future policy records
one read-only packet, one attempt, no fallback, no inherited execution carrier
and no automatic dispatch. These fields are an intended admission contract;
they do not assert runtime enforcement. There are no mission or packet IDs.

The operator-authenticated `GET /api/plugins/task-drafts` route lists the current
account's drafts and contracts for local inspection, with a session-current
indicator. Plugins, workers and devices cannot access it. No dispatch endpoint
or renderer review UI is included in this increment.

Plugin audits contain argument digests and task IDs, never draft text,
credentials, repository paths or results. The private draft itself retains its
contract and workspace identity for operator inspection.

## Source acceptance

The real-route fixture uses actual middleware, locally signed capabilities,
signed synthetic account licenses, real Git repositories, canonical project
membership, durable files and the existing headless loop. Native worker
execution is a guarded fake boundary so a regression cannot start a live worker.

Required coverage:

- Prepared receipts remain held, preserve an existing mission and produce zero
  launches through headless ticks.
- Concurrent exact retries publish one draft; independent processes share the
  persistence lock and a cold process can read the original receipt.
- Exact retries survive expired snapshots and publication-before-lock-removal.
  Changed arguments conflict, and an interrupted final audit never duplicates a
  draft.
- Old read/follow-up grants, other accounts, missing epochs, expired signatures,
  sign-out and switches during admission are refused.
- Returning to the same account under a new sign-in epoch does not admit an old
  snapshot or disclose its retry receipt.
- Stale workspaces, project mismatch, path escapes, symlinks, incompatible pins
  and scope/policy overrides are refused.
- Local inspection stays behind the operator principal; unfinished locks stay
  held, and local capability expiry respects OAuth expiry.

## Remaining before a ChatGPT worker run

The existing desktop sign-in epoch writers do not provide an atomic
cross-process account-transition transaction. Checks here reduce stale
admission, but a transition after a check can leave a held draft. It cannot
authorize execution because drafts have no dispatch consumer. Future dispatch
must introduce an atomic admission boundary and revalidate the account,
snapshot, workspace and current rules.

Worker creation must preserve existing missions, create an isolated workspace,
resolve the execution carrier explicitly and enforce the immutable attempt and
fallback policy at every retry/recovery seam. It also needs an operator review
surface, stop behavior, audit reconciliation, installed acceptance and independent
security review. Actual dispatch needs its own permission and consent; a
preparation grant must never silently become execution authority.

Only after those boundaries pass should production activation and a disposable
ChatGPT web/phone-to-desktop worker run be reviewed. Hosted refresh/revocation,
account isolation, reviewer walkthrough and allowance measurement remain separate
acceptance items. Neither preparation nor provider token counts prove an
allowance-saving benefit.
