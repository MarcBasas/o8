# Interactive intent-continuity demo

Run the pinned authored-intent checker and version storage, try the mobile clarification panel, and inspect the planned two-runtime continuity experiment.

This is a standalone development tool. It does not start or configure the o8 app.

## Run

Requires Node.js 22 or newer, npm and Python 3.10 or newer. The first preparation downloads declared public source. Subsequent runs verify the cached identities.

From this checkout:

```sh
cd scripts/intent-continuity-demo
npm ci
npm run demo
```

Open the loopback URL printed by the command. The server chooses an available port. Stop it with Ctrl+C.

No API key or model is required. Generated source, compiled files and synthetic records live under this package's ignored `node_modules/.cache` directory. Local receipts stay in ignored `receipts/`. No application database or saved runtime configuration is touched.

## What to try

1. Check the sample instructions.
2. Save the original at version 0.
3. Save the same instructions again. The original timestamp stays unchanged.
4. Try to overwrite that version. The actual store refuses the change with 409.
5. Add revised instructions at version 1.
6. Read the original again. Both versions remain.
7. Open the clarification panel and choose input latency or animation. Dismissal records no choice.
8. Open the planned handoff test and step through its expected behavior.

The checker validates document rules and identity. It does not decide whether a natural-language goal is complete, whether a worker obeys it, or whether the task is finished.

## Source and fixture boundaries

`sources.json` pins every downloaded file by commit and SHA-256:

- Actual route, validator bridge and immutable store: downstream authored-intent draft, commit `16e2dd430e274eeb344a66eec2bbbe7adb3f40d9`.
- Actual AODL checker checkout: consumer CLI draft, commit `ba9190a6dadcc5ca747c7766b3b53bfc246ce53e`.
- Actual mobile panel, shared typography and semantic parser: mobile draft, commit `ffb2b152ebec6be647b5905d9b53f809a56dbebc`.

The downloaded implementation files are unchanged. Build aliases provide fixture request/response classes, authentication, operator role and a private data directory. The question, options, palette, callbacks and task are synthetic. Unused shared-module exports are fixtures.

This does not certify real bearer authentication, middleware, live dictation, installed-host integration, mission dispatch, real cross-runtime completion or power-loss durability. The clarification choice is not connected to the newly saved instruction revision.

## Verify

```sh
npm test
npm run test:checker
```

The first command drives the actual route/storage/checker, including original-record recovery in a new process. The second runs the pinned AODL CLI's 18 real-process tests. Receipts and failures must be read as local fixture evidence, not production acceptance.

The broader repository gates are separate:

```sh
npx tsc --noEmit
npm test
```

Run those from the repository root. The downstream base currently has a separate [workflow-policy failure](https://github.com/hurttlocker/o8/issues/3234); this demo does not repair that workflow.

## Next experiment

The final screen is an illustrated plan, not an execution result. [experiment.md](./experiment.md) defines the live task, unchanged-source control, deliberate source change, acceptance checks and receipts.

Related work: [intent loop](https://github.com/hurttlocker/o8/issues/3184), [handoff continuity](https://github.com/hurttlocker/o8/issues/3186), [shadow decisions](https://github.com/hurttlocker/o8/issues/3187), [system-wide clarification](https://github.com/hurttlocker/o8/issues/3188).
