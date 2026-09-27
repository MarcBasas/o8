# Workspace UI release acceptance

Source integration is not release proof. Keep issue closure and shipped acceptance separate.

| Scope | Tracking | Source state | Release acceptance |
| --- | --- | --- | --- |
| Compact worker layout | #2814, #2763 | Combined candidate | Four real workers and ten simulated panes at compact and large sizes; scroll, focus, close, drag, reload |
| Fast shared checkout | #2772 | Combined candidate | Packaged orchestrator, scoped workers, reviewed commit, team closure, cold restore |
| Shared workspace pages and navigation | #2817 | Combined candidate | Projects, Customize, Automations, Handoffs replies, tab ownership and retained pane layouts |
| Managed-run observation | #2816 | Combined candidate | Attach, resize, visibility and reconnect preserve worker input and dimensions |
| Account drawer release shortcut | #2769 | Included in shared UI candidate | Settings and help remain reachable |

Development-only worker previews and the compact rail study remain development-only. Onboarding media remains deferred under #2781 and #2782.

## Candidate evidence

- Rendered page tests cover shared headings, automation loading, tab ownership, worker identity and steer receipts.
- The packaged app exposes Projects, Customize and Automations with their shared headings and return actions; the Handoffs panel opens and reports its empty state.
- Native development preview: ten simulated workers remain readable at 1100 by 800 with independent scrolling; all ten fit at 2200 by 1200.
- TypeScript and touched-file ESLint passed. Fast integration passed 37 tests across eight files; terminal integration passed all four real WebSocket/PTY tests.
- Observer-first attach, writer resize, reconnect and writer detach preserve read-only boundaries. Two views of the same session on one WebSocket still share one mode; the read-only guard wins.
- Exact-head hosted checks passed at `e4c3a01fe`, including 830 hermetic test files, changed-file integration, security, governance, type, lint and Linux/Windows compilation.
- Fast scope review reports both sides of a rename; the real Git regression rejects finalization and retains ownership (#2818).
- Packaged Fast execution passed with four real workers, four disjoint file scopes, one verified commit, and archived team ownership. Worker panes did not attach after the composer changed the project; acceptance remains blocked by #2821. Existing-chat target persistence is tracked separately in #2820.
- Isolated-mode placement requires storage admission. Do not bypass its reserve or silently substitute Fast mode.
