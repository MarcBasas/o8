# Standalone Cloud Worker CLI

This worker consumes durable cloud jobs from an o8 instance, runs each job in a
fresh clone, pushes the requested branch, and writes durable output back to the
job. It uses only the scoped cloud-worker credential. It does not accept the
operator bearer token or the legacy `/api/worker/*` credential.

## Prerequisites

- Node.js 22 or newer, `git`, and the `codex` CLI on `PATH`.
- GitHub authentication that can clone and push the dispatched repository. Use
  `gh auth login`, `GITHUB_TOKEN`, or `GH_TOKEN` on the worker host.
- An o8 URL reachable from the worker host.
- A provisioned cloud worker key with the `cwk_` prefix. Keep the key in a
  secret manager or `O8_CLOUD_WORKER_KEY`; do not put it in shell history.

## Build and run

```bash
npm run worker:build
node dist/worker/o8-worker.mjs --o8-url https://o8.example
```

The repeatable local integration check is
`npx vitest run tests/cloud-job-spine-real-path.test.ts`. It starts the built
worker as a child process against a local HTTP bridge, a Git remote fixture,
and a fake Codex executable. It verifies clone, push, exact result commit,
transcript, changed files, restart, lease recovery, scoped auth, and abort.
It does not establish that a worker can keep running while the operator's
laptop is disconnected; that requires a separate host and reachable o8 URL.

Set `O8_CLOUD_WORKER_KEY` through the host's secret manager before running the
command. `--worker-key` also works for automation that protects process args.

The worker stores its opaque worker ID and durable poll cursor in
`~/.o8/worker/worker-state.json` by default. Set `--workspace-dir <directory>`
to move both this state file and per-attempt clones. Set `--worker-id <opaque-id>`
only when the host needs a fixed external identity.

Upgrade the o8 server and this worker together. Older worker builds using
`/api/worker/*` are a separate, non-durable protocol and cannot consume jobs
from `/api/cloud/*`. Existing legacy workers can finish their own jobs during
the transition; do not reuse a legacy credential as a cloud worker key.

## Runtime protocol

- Dispatch through `POST /api/runtime/launch` with `runtime: "cloud"`, a real
  packet ID, the registered repository, and the assigned branch. The route
  creates or binds a governed cloud lane and returns its ID with the durable
  session key. The general mission picker remains disabled for cloud until it
  can show external-worker availability accurately.
- Long-polls `GET /api/cloud/worker-poll` with the persisted cursor and worker
  ID. A returned job includes a worker-bound lease token.
- Requires `launch.remoteSource` with `repoUrl`, `baseSha`, and `branch`. The
  worker clones that repository, checks out the exact base SHA, and creates the
  requested branch.
- Sends `chunk`, `diff`, `heartbeat`, `completed`, and `errored` events to
  `POST /api/cloud/worker-stream`. Rejected stream writes stop the owned Codex
  process and leave a visible local failure receipt. A lost POST acknowledgement
  is treated as uncertain; the worker does not replay a mutation without a
  server event idempotency key.
- Polls `GET /api/cloud/worker-control` during clone, Codex execution, and push.
  An `abort` stops the owned process before acknowledgement. A live `steer`
  remains pending while the one-shot Codex process finishes; the server queues
  it as an ordered follow-up job at completion.
- Refuses `workMode: "read-only"` jobs because this executable invokes Codex
  with write authority. It reports the refusal as a durable job error.
- On restart, resumes its worker ID and queue cursor from disk. A job still
  leased to a stopped process becomes claimable again after lease expiry, in a
  fresh clone. Repeated execution failures park the job after its attempt
  budget; an operator can inspect its transcript and retry deliberately.

The worker does not log its cloud key, bearer header, or credential-bearing
repository URL. Clone, Codex, push, and event failures are sent to the durable
job when the lease is still valid and are also visible in the worker process
output.

## Troubleshooting

### `401` or `403`

The cloud worker key is missing, revoked, malformed, or belongs to a different
team. Provision a fresh scoped cloud worker key. Do not substitute an operator
token.

### `cloud job has no valid remote source`

The dispatcher did not provide the durable remote source record. Fix the job at
the dispatcher. The worker deliberately does not use an operator machine path.

### `read-only cloud jobs are unsupported`

Send this job to a worker that enforces read-only execution, or dispatch an
explicitly writable cloud job after review.

### Clone or push failure

Confirm the worker host can access the repository and that its Git identity can
push the requested branch. The worker keeps the per-job clone for inspection.
