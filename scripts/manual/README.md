# Manual scripts (not part of `pnpm test`)

These are one-off probes and driver scripts kept for reference. They are **not**
run by CI and **not** covered by any assertion, so a green `pnpm test` says
nothing about them.

They were moved here from `test/` because sitting next to the six committed
suites made them look like part of the regression set. Two things to know before
running any of them:

- **They hardcode port `18765`**, while the hub's default is `18764`. Start the
  hub on the port the script expects, or edit the constant at the top.
- Several need things this machine may not have: a real `herdr` (any
  `drive-*.mjs` / `agent-check.mjs` / `status-test.mjs`), a specific agent TUI on
  a specific pane id, or a running hub you started yourself
  (`live-multi-peer.mjs`). `slash-test.mjs` additionally calls
  `bridge_history { peer: 'agent' }`, which is manager-gated now, so it fails as
  written.

| Script | What it does |
|---|---|
| `probe.mjs` | Ad-hoc HTTP probe of a running hub |
| `live-multi-peer.mjs` | Drives several real peers against a hub you started |
| `task-mcode.mjs` | Task + ack round trip against a MiniMax Code TUI |
| `drive-claude.mjs` / `drive-mcode.mjs` | Type into a Claude / mcode pane over herdr and read the reply |
| `agent-check.mjs` | Ask herdr which agents it recognizes |
| `status-test.mjs` | herdr pane status transitions |
| `slash-test.mjs` | Slash-command execution through a herdr pane |

For anything that must hold, add an assertion to one of the committed suites
(`test/smoke.mjs`, `test/setup.mjs`, `test/ops.mjs`, `test/herdr.mjs`,
`test/discover.mjs`, `test/e2e.mjs`) instead of leaving it here.
