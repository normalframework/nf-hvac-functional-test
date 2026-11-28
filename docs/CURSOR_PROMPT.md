# Cursor cloud agent prompt: build v0.1

Paste everything below the line into a Cursor cloud agent for the repo `normalframework/nf-hvac-functional-test`. Run it with medium reasoning effort, not fast mode.

---

You are building v0.1 of `nf-hvac-functional-test`, a Normal Framework (NF) app that runs automated HVAC functional tests on air handling units (AHUs), with an optional VAV max-cooling-airflow step. The complete design is in `docs/DESIGN.md` in this repository. Read it fully first, then read the references below. The design is the specification. If you find it wrong or incomplete, make the smallest sensible decision, record it in `docs/DECISIONS.md`, and keep going. Do not stop to ask questions.

## References (read before coding)

- `docs/DESIGN.md` (this repo): sequence, state machine, config schema, data logging, safety and release, NF integration, test plan, open questions.
- NF command service concept page: https://docs.normal.dev/concepts/commands/ and proto: https://buf.build/normalframework/nf/raw/main/-/normalgw/hpl/v2/command.proto (routes: `POST /api/v2/command` start, `POST /api/v2/command/write`, `POST /api/v2/command/read`, `POST /api/v2/command/{id}` extend with `new_expiration`, `DELETE /api/v2/command/{id}` cancel, `GET /api/v2/command` list, `POST /api/v2/command/clear`, zombies under `/api/v2/command/zombies`). Command lifetime maximum is 24 h; names must be unique; expiry clears the priority-array slot.
- NF hooks guide: https://docs.normal.dev/applications/hooks/ (hook definition JSON, `MODE_SCHEDULED` with RRULE incl. `FREQ=SECONDLY`, `MODE_ON_REQUEST`, global variables, `invokeTimeout`).
- NF API examples: https://github.com/normalframework/nf-sdk/tree/master/examples/api (command v2 write-with-context, BACnet v2 write-property, point query).
- Example NF apps in https://github.com/normalframework: `applications-template` (hooks, `point.write` with `bacnetOptions.priority`, jest tests with the SDK test instance), `heartbeat` (10 s scheduled hook with a global variable), `nf-snmp` (app.json with layer and driver, engine hook pattern, `lib/nf` REST client and in-memory fake, `local/` persistence, vitest unit tests), `alc-plugin`.
- Open-FDD NF app for conventions: https://github.com/bbartling/open-fdd (`nf-app/`). Point-role naming convention: 223P-derived snake_case, SI units on the wire (open-fdd issue 1804). Do not copy Open-FDD code.

## Hard rules

1. Generic only. No site names, building names, equipment IDs, point names, client names, vendor product names or people names in source, tests, fixtures, docs or commit messages. Use synthetic IDs like `ahu_a`, `vav_01`, and random UUIDs in fixtures. Point roles are 223P-derived snake_case from `docs/DESIGN.md` section 5.1. All thresholds and config values are SI (degC, Pa, %, m3/s). Imperial is display-only.
2. Safety first. Dry-run is ON by default. Writes need `dry_run: false` in config and `confirm_live: true` on the START request. BACnet priority is configurable (default 8, integer 3 to 16; 1 and 2 always rejected). Every override is written to the ledger before it is sent. Every exit path releases all overrides and verifies the release. Never leave a point overridden. The release and safety tests in `docs/DESIGN.md` section 9.3 must exist and pass.
3. The state machine is pure (`next(state, event) -> { state, effects }`). Effects are executed by a runner with an injected clock, NF client, ledger and sampler, so everything is testable without NF.
4. No secrets, tokens, license keys or real hostnames anywhere. NF credentials come from the NF app runtime only.
5. No network access in tests. Use the fake NF backend you build in PR 2 and a virtual clock. No sleeping in tests.
6. Analytics and fault detection are out of scope. Capture data and the run manifest only.
7. Keep the code small and plain. Node.js 20+, CommonJS (as the NF app examples), no TypeScript build step unless you need it for type checking only (JSDoc types plus `tsc --noEmit` is fine). Minimal dependencies; pin versions; use `@normalframework/applications-sdk` only in the thin hook adapters. Tests use the built-in `node:test` runner or vitest; pick one and keep it.
8. Wording in docs and comments: professional, concise, no filler, no AI-style phrasing, no emoji.

## Workflow rules

- Work in small, focused pull requests against `main`, in the order below. Each PR must have CI green before you open the next one. Branch names: `v0.1/<short-topic>`.
- Do not merge any PR. Do not change repository settings, branch protection or the license. Do not force-push to `main`. No admin overrides.
- Each PR description: what changed, how it was tested (commands and results), and which sections of `docs/DESIGN.md` it implements. If you deviate from the design, say why and add the entry to `docs/DECISIONS.md`.
- Update `docs/DESIGN.md` only to correct errors you found; list those corrections in the PR description.
- At the end, post one summary comment on the last PR (or open an issue titled "v0.1 status") listing: PR links, test counts, coverage on the safety modules, deviations, and the open questions from section 11 with what you verified or could not verify.

## PR plan

**PR 1: scaffold, config, roles.**
`package.json`, `app.json` (RUNTIME_NODE_JS, layer `ftest` with `equipment_id`, `role`, `source_uuid` components, options `siteConfig`, `enabled`, `logLevel`, API-key scopes per the open-fdd `nf-app/app.json` as a starting point, noting open question 3), `.github/workflows/ci.yml` (Node 20 and 22, `npm ci`, lint, type check, tests, coverage floor, schema validation of example configs, source scan for forbidden identifiers using a word list in the CI config, dependency audit), `schema/site-config.schema.json`, `lib/roles.js` (registry with direction, SI unit, clamps, required flags), `lib/config/` (validate, defaults, priority rule, `writable` allow-list), `examples/site-config.example.json` (synthetic), unit tests for config and roles, `.editorconfig`, lint config. README gets a Development section.

**PR 2: fake backend and virtual clock.**
`test/fake/` as described in `docs/DESIGN.md` section 9.1: virtual clock, fake NF HTTP server (point query and upsert, AddData batch, command service with unique names, extend, cancel, expiry reversion, zombies, guardrail rejection, `cancel_on_conflict`), direct BACnet v2 ReadProperty and WriteProperty with a real 16-slot priority array and NULL relinquish, device profiles, AHU physics model (simple, plausibility only) with fault injection, VAV box profiles (`flush_capable`, `setpoint_writable`, `setpoint_ignored`, `setpoint_readonly`, `offline`, `higher_priority_override_active`), request-failure injection. Tests for the fake itself (expiry reverts, priority array semantics). `lib/nf/client.js`: REST client with retries and a narrow interface (`readPoints`, `queryPoints`, `upsertPoints`, `addData`, `startCommand`, `writeInCommand`, `extendCommand`, `cancelCommand`, `listCommands`, `readPriorityArray`, `bacnetWrite`).

**PR 3: ledger, writers, release.**
`lib/ledger.js` (write-ahead JSONL, fsync, snapshot by temp+rename, corrupt-tail tolerance), `lib/writers/{nf_command,dry_run}.js`, release procedure with verification and backoff (`docs/DESIGN.md` 7.3, 7.4, 7.7), restart recovery including cancelling `ftest-*` contexts when the ledger is missing, `NEEDS_ATTENTION` handling. Tests: write-ahead ordering, crash between intent and result, release verification, release retry and `NEEDS_ATTENTION`, no-keepalive expiry on the virtual clock, `bacnet_direct` slot discipline, dry-run makes zero write calls, live gating (both flags).

**PR 4: state machine, AHU steps, interlocks, sampler, manifest.**
`lib/machine.js` (pure; table-driven tests for every state and event), `lib/runner.js`, `lib/capability.js` (AHU part), `lib/interlocks.js`, economizer eligibility, `per_point` and `mode_point` AHU strategies, `lib/sampler.js` with shadow sampling into layer `ftest` plus the `ftest_run_seq` and `ftest_step_index` points, `lib/manifest.js`. Period boost mode may be implemented behind the experimental flag with tests, but is off by default. Tests: full AHU plan on the fake AHU, release on abort at every state, timeout, every interlock, comm loss and tick gap, restart recovery during `ahu.recirc`, operator takeover (release and stop), the randomized invariant test from section 9.3, manifest step windows match the sampled step index series.

**PR 5: VAV max-cooling-airflow step.**
`lib/vav/{bas_toggle,flush_point,airflow_setpoint}.js`, strategy `auto` and `auto_per_box`, per-box capability detection and the capability report (section 4.3) with all skip reason codes, `max_boxes_overridden`, batching and paced release, `write_not_effective` detection by readback, `no_effect` detection for `bas_toggle`, AHU mode selection (`auto`, `recirc`, `economizer`), hold timer default 30 min (min 5, max 120), release order VAV then AHU. Tests: each strategy on the fake fleet with mixed box profiles, skip reasons, limits and pacing, release on abort mid-batch, interlock trip during the VAV hold, insufficient capability skips the step and the run still completes.

**PR 6: hooks, operator API, status page, docs.**
`hooks-update/tick.json` (SECONDLY, interval 10, `invokeTimeout` 8 s, global variables `ftest_state`, `ftest_step_index`, `ftest_run_seq`, `ftest_overrides_active`, `ftest_needs_attention`), `hooks-update/admin.json` (ON_REQUEST), `hooks/tick.js` and `hooks/admin.js` as thin adapters (load config, build runner, call it, best-effort SIGTERM release), operator actions (`start`, `abort`, `status`, `retry_release`, `acknowledge`, `config validate`, `config discover` read-only), `static/` status page (state, step, time left, active overrides, interlock readings, release status, capability report, one-click abort, dry-run banner), `docs/INSTALL.md` (install from git as an NF app, options, recommended write-guardrail policy: deny by default with an allow rule for this app's API key and clamp rules for 0 to 100 percent), `docs/OPERATIONS.md` (dry-run rehearsal, lab run checklist, what to do on `NEEDS_ATTENTION`), `docs/sql-examples.md` (label trend data with the manifest step windows; DuckDB and PostgreSQL examples), README update. Tests: admin action handling with the fake, tick adapter smoke test, static page loads.

## Definition of done for v0.1

- All six PRs open with CI green, none merged.
- `npm test` passes with no network; coverage on `machine`, `ledger`, `runner`, `writers`, `interlocks` is at least 90 % lines.
- The randomized release invariant passes for at least 200 seeds in CI.
- Example config validates; a dry-run of the full plan completes on the fake backend with zero write calls and a complete manifest.
- No forbidden identifiers or secrets in the repo (CI scan passes).
- `docs/DECISIONS.md` lists every deviation and every open question you resolved, with evidence.
- The final status comment is posted.

Start with PR 1 now.
