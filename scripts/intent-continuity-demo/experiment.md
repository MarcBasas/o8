# Planned real-task continuity experiment

Status: planned. The demo illustrates the sequence; it does not run agents.

## Task

Select one reproducibly slow interaction in a dedicated fixture checkout. Record its current appearance, measured response time and existing behavior.

The operator points to the interaction and asks:

> Make this respond faster. Keep the layout and existing behavior. Do not deploy.

If “faster” is ambiguous, ask one useful question. Record the accepted meaning, baseline measurement, agreed target and verification procedure in authored intent R1. Do not invent a target without the baseline.

## Live sequence

1. Persist R1, then dispatch worker A through the normal o8 task path.
2. Let A inspect the relevant file and create its normal worker task contract.
3. Capture the intent reference and source-backed handoff state.
4. Compact or hand the task to a different supported runtime, worker B.
5. Before B acts, deliberately change the relevant source file in the fixture checkout.
6. Confirm B detects the changed source and refreshes its evidence before editing.
7. Finish without asking the operator to restate R1.
8. Verify the result against the original target, layout and behavior constraints.

## Control

Repeat the same handoff with unchanged source. B should retain the original goal and continue using current evidence without rereading unrelated history.

## Pass criteria

- R1 remains the same saved authored intent across compaction and both workers.
- The changed relevant source invalidates the carried claim before B acts.
- B rereads current source; it does not edit using the stale assumption.
- Final measurements satisfy the agreed target.
- Layout and interaction checks pass.
- No deployment or permission expansion occurs.
- The operator does not restate the goal.
- The unchanged-source control avoids unnecessary refresh.

## Evidence

Keep intent identity, source revisions, handoff identity, the changed-file event, B's observation before its edit, final verification and control results. Measure elapsed time, total parent-plus-worker usage, retries, corrections and operator interruptions.

Report fixture/server authentication separately from real app authentication. Record unknown or failed checks explicitly.

Shadow decision helpers can be a later experiment. Do not let a confidence score decide that this task passed.
