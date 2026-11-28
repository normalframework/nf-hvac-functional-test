# Decisions

Gaps and departures from `docs/DESIGN.md`. The design remains the spec except where a row here says otherwise.

## D1. Test runner

`node:test` and `tsc --noEmit` on JSDoc. One runner for the app. No TypeScript emit.

## D2. Schema and defaults

`schema/site-config.schema.json` is JSON Schema 2020-12, checked with Ajv. The schema describes operator input. Omitted fields take the defaults in `hooks/lib/config/defaults.js`. `dry_run` defaults to true. `bacnet_priority` defaults to 8.

## D3. Priorities 1 and 2

Rejected by `checkPriority` and by the schema (integer 3 to 16). There is no override flag.

## D4. Command lease

`keepalive_s` must be less than `command_lease_s`. The lease maximum is 86400 seconds (the command service 24 hour limit). The minimum lease is 30 seconds. `release_backoff_s` must contain at least `release_retries` entries.

## D5. Unimplemented catalog steps

Section 3.4 step ids are valid in the schema. Enabling one fails config validation with `step_not_implemented`. The planner also skips an enabled catalog step with that reason.

## D6. max_concurrent_runs

v0.1 accepts only 1.

## D7. max_reads_per_s

Default 50, used only when logging mode is `period_boost` or `both`. The default mode is `shadow`. Open question 1 is unverified, so period boost stays off.

## D8. Plausible clamps

Air temperatures -50 to 80 degC. Relative humidity and percent commands 0 to 100. Duct static pressure -500 to 5000 Pa. Airflow 0 to 100 m3/s before any tighter cap. These are sanity bounds, not site setpoints.

## D9. Equipment ids

`^[a-z][a-z0-9_]{0,63}$`. `serves` may only list VAV ids in the same config.

## D10. API scopes and minimum version

`app.json` scopes are the open-fdd app scopes. They are not verified against a running NF (open question 3). `minNfVersion` is `3.10.0` because the design says the command lease and zombies arrived in 3.10.x. That floor is not a lab-verified minimum.

## D11. siteConfig option

The app option defaults to an empty string so the app can be installed before a config exists. An empty config does not validate and cannot start a run.

## D12. ftest layer

Indexed components `equipment_id`, `role`, `source_uuid`. No protocol driver. Shadow points are written with the data API.

## D13. Coverage floor

`scripts/check-coverage.js` requires 90 percent line coverage on the config, role, model, and plan modules, and on the safety modules in section 9.5 once those files exist. The coverage run does not pass `--test-coverage-include`; Node 20 rejects that flag. The script expands `tests/*.test.mjs` itself because Node 20 does not expand that glob. Files under test are loaded by the test suite, and a required file with no line data fails the check.

## D14. Forbidden-identifier scan

`.github/forbidden-words.txt` is the denylist and is excluded from the scan. The scanner also rejects private-key blocks and common token prefixes.

## D15. Data-model-driven planning

Owner requirement, applied before any sequencer was written.

The Haystack tag adapter is the primary model input. It reads NF point tags and layers directly. `hooks/lib/plan.js` is pure. RDF input does not build a model (D19).

`schema/haystack-role-map.json` is versioned. `mergeMaps` overlays a site file onto the shipped Haystack map.

Writable comes from the `writable` marker. A `cmd` or `sp` tag does not make a point writable by itself. `evaluateWrite` refuses the write when the model marker is absent, even if config sets `writable: true`. When a config binding exists it must also set `writable: true` (operator allow-list). A discovered point with no config binding is allowed when the model marks it writable. `confirmRuntime` then requires a priority array and, when a readback probe is present, a matching readback. Disagreement skips the point; it does not write it.

`air flow sp` plus `writable` maps to `discharge_air_volume_flow_rate_setpoint`, not to `discharge_air_volume_flow_rate_maximum`. The maximum stays the read-only cap from section 5.1. The requirement's example named the maximum role for the writable airflow point; the design table gives that job to the setpoint role. Sites that tag the cap differently edit the JSON map.

`ahu.economizer` is skipped with `economizer_points_missing` unless `outdoor_air_intake_damper_position_command` is model-writable. Recirculation still runs from the coil commands when the damper point is absent. The damper is written during recirculation only when the model marks it writable. Weather remains a runtime precondition (`econ_window`), not a planning input.

A VAV box is not special-cased by id. Strategy order is the site policy (`auto`, `auto_per_box`, or one strategy). The model decides which of those strategies each box supports. Boxes past `max_boxes_overridden` are skipped with `over_box_limit` after sorting ids, so the cut is stable and not a per-box rule.

Interlocks whose input points are unbound are omitted from the plan. Required AHU sensor roles (`requirement: yes`) still fail config validation when an AHU equipment entry lists points and omits one. Write roles are not required at config validation time; a missing write role becomes a skipped step.

## D18. Haystack role matching

Matching is longest tag set, then a hard rule: a `cmd` marker keeps only roles that list `cmd`. An equal-length tie assigns no role and is reported on the model `ambiguous` list. Setpoint roles forbid `max` and `min`. The shipped map uses Haystack 4 tokens (`cool`, `heat`, `freezeStat`, `ductStatic`, damper tags without `air`). `class` and comma-separated `markers` are tag sources. Role ids stay in `hooks/lib/roles.js` and `schema/haystack-role-map.json`.

## D19. RDF input is refused until the shared role file lands

`hooks/lib/model/rdf.js` no longer splits Turtle. `loadRdfModel`, `parseTtl`, and `loadRdfMap` throw `RdfInputDisabledError`. `schema/rdf-role-map.json` is removed so local-name types cannot bind a role. `matchRoleIri` matches the full IRI and returns null on zero or several roles. `schema/shared-role-file.pin.json` records Oxigraph 0.5.13, the 223P ontology sha256, and a null role-file hash. `checkVendoredRoleFile` fails when a vendored file's sha256 differs from that pin.

Vendoring Oxigraph and the shared role file waits on the review that names the role file. The Node hook still has no Python, so OntoEnv and Shifty stay in CI. Haystack planning is unchanged. The follow-up steps are in `docs/superpowers/plans/2026-11-26-rdf-alignment.md`.

Update: Oxigraph 0.5.13 is now vendored at `static/vendor/oxigraph/` (the same files as the Open-FDD NF app), used by the page's functional test graphic only (D25, D26). The hooks still refuse Turtle; the test plan is still built from the site config and Haystack tags.

## D16. Assumed NF routes

Point query, point upsert, and AddData are `POST /api/v1/point/query`, `/api/v1/point/upsert`, and `/api/v1/data`. Direct BACnet is `POST /api/v2/bacnet/read` and `/api/v2/bacnet/write`. Command routes follow the command service under `/api/v2/command`. None of the point or BACnet paths were verified on a running NF (section 11, questions 2 and 6). `cancel_on_conflict` fails the new write and leaves the existing command running. The fake listens on `127.0.0.1` only and is not part of the installed app.

## D17. Release verification

A corrupt JSONL line is skipped wherever it sits, so one bad line cannot hide earlier overrides. After `CancelCommand`, a slot that is still occupied is relinquished with a NULL write at the same priority. That covers a zombie the command service did not clear. Other slots are not written. A `failed` ledger result removes that override; an `intent` with no result is treated as possibly written and is released.

## D21. Role names come from the vendored Open-FDD vocabulary

`vendor/roles/openfdd-roles.json` is `roles/openfdd-roles.json` from Open-FDD commit `49d44e23f8be7da7aa34d10ff67cd50dee13d51b` (vocabulary `1.1.0-draft.1`, file field `openfdd_release` `5.0.22`, status `draft`). `schema/openfdd-roles.pin.json` records that commit, sha256 `43717ebc6187f678e3ee424b5e877f14dcd92e387bfdcedd7cbdb2f9b5eb85c1`, and `pinned_to_tag: false`. The intended tag is `v5.0.22`. CI compares role names to that commit and fails if they differ. It does not fetch the tag. `hooks/lib/roles.js` keeps only the entries whose consumer is `nf-hvac-functional-test`. The id is the 223P role name. Haystack markers, including custom markers, are the binding and are read from that file. Wire units are the QUDT tokens (`DEG_C`, `PA`, `PERCENT` on a 0 to 100 scale, `PERCENT_RH`, `L-PER-SEC`). They are not fractions. Older names in the file's `aliases` still resolve.

The RDF pin in `schema/shared-role-file.pin.json` is unchanged. That path is still the absent Turtle file. This JSON vocabulary does not turn the RDF adapter back on.

## D20. Command-service BACnet priority

NF documents `BACNET_PRIORITY` as the command process environment variable (default 12) and exposes platform environment variables at `GET /api/v1/platform/env`. A live `nf_command` run reads `name=BACNET_PRIORITY` before the first command. An integer that differs from `write.bacnet_priority` fails the run with `priority_mismatch` and creates no command. A 404 or an empty variable list means that NF build did not expose the setting. The app does not assume 12 in that case. Per-write `priority` on `/api/v2/command/write` is still sent. It is not a substitute for the process-wide value, because the command service uses one priority for the process.

## D22. The hook builds the plan from the site config

`hooks/tick.js` and `hooks/admin.js` install a factory when a test has not injected one. The factory reads the `siteConfig` option, validates it, and builds the model from the configured point uuids. A binding that uses `query` is resolved with `equip_ref` (and optional markers). An empty query is refused. Discover uses the same rule. The runner is paced, and `vav_index`, `next_retry_at`, and `last_extend_at` are stored in the state file so a new process continues the same batch. `NF_BASE_URL` or the `nfBaseUrl` option selects the on-box API. The default is `http://127.0.0.1:8080`. `dry_run` still defaults to true.

## D23. Scheduled trigger cadence and timezone

The trigger hook runs on a fixed one-minute NF schedule and evaluates the stored rule itself in the rule's timezone (`static/rrule.js`, shared with the page). Binding the hook directly to a user RRULE would depend on NF's `DTSTART;TZID=` handling, which is not verified; a UTC `DTSTART` with `BYHOUR` would drift an hour at each daylight saving change. The page still shows the equivalent NF RRULE for reference. An occurrence is due for 10 minutes after its time and is handled once (`last_occurrence`). The trigger only queues `pending_start`; the tick hook starts the run through the same path as a manual start, so release behaviour is unchanged.

## D24. Page state view

`hooks/lib/machine.js` is unchanged. The page maps its phases to operator states (`static/stateview.js`): IDLE or SCHEDULED (trigger on), PRECHECK, OVERRIDE (step written but not confirmed), SETTLE, CAPTURE, RELEASE (RELEASING and RECOVERY), REPORT (COMPLETE, ABORTED, FAILED), and NEEDS_ATTENTION off the path. Countdowns come from `step_started_at`, `hold_ms`, `settle_ms` and `max_total_ms` in the admin `status` answer. The admin hook reads the tick hook's state file, because the two hooks run as separate processes.

## Open questions

Section 11 is still open. Nothing in it was verified against a running NF. `period_boost` stays off.

## D25. Functional test graphic: 223P model derived from NF tags, sim and playback in the browser

The graphic tab builds everything from a 223P model: AHUs (`s223:AirHandlingUnit`), their parts in air-path order (walked over connection points, connections and `Fluid-Air` media), the terminals each one serves and the spaces those feed. `static/s223.js` walks the graph and matches every property to an Open-FDD role by the role's 223P pattern (`static/roles-223p.js`, generated from the vendored roles file; patterns without a scope win, then the most specific, a tie stays unbound). The model itself is derived from NF tags (`static/tags-223p.js`): points bind to roles by the roles file's normative `haystack.binding_rules` (`static/haystack-bind.js`: classes, markers or alt sets, custom markers, forbid, one function marker, parent `equip_markers`/`equip_forbid`, strict superset, `binding_scope` own), then each bound point is emitted as the 223P property its role's pattern names, on the part and connection point the pattern names. Parts are ordered by 223P class and role (intake dampers, mixing, filter, preheat, cooling, heating, supply fan); valves attach to the coil of their duty. A test checks the round trip: the role a tag set binds is the role its 223P pattern matches, for every point of the demo site. A second test checks the binder reproduces all 77 own-scope roles of the roles file from their own tag sets (parity recipe step 4). Open-FDD's nf-app has no tag-to-223P code at release/5.0.22 (its graph is Haystack plus Brick refs), so this derivation is ours; the roles file and the Turtle builder are shared.

`static/graphic.js` is a deterministic sim (closed-form fan and duct: P = P0·s²/(1 + a·K²), Qi = ki·c(pos)·√P; mixing; coil ΔT; first-order lags) and a stroke-test driver: per terminal with a damper command and feedback, 0/100/50 % with tolerance, timeout and capture; precheck (fan proven, duct static), a static-pressure interlock, operator abort and run timeout; every override is released on every way out and the release is verified. The diagnosis is a rule table: feedback short and airflow matching it is actuator binding, feedback right and airflow wrong is a slipped linkage, airflow right and feedback wrong is feedback scaling. The sim never calls NF (`nf_writes: 0`). The scene (`static/graphic-scene.js`, three.js r170 vendored like Oxigraph, loaded only when the tab opens) draws only what `NfftGraphic.layout` returns.

## D26. Co-existence with Open-FDD

NF tags are the source of truth. When the Open-FDD app answers, the graphic reads Open-FDD's graph through its read-only `rdf` hook (`POST /api/v1/apps/open-fdd/hooks/rdf`, paged with its `snapshot`) and builds no second graph from records. When it does not (404, error, no answer within 5 s, or an answer shape this page does not know), the page builds the same Turtle from NF point records with a vendored, unmodified copy of Open-FDD's `static/model.js` (`modelToTurtle`, `nfBase: ''`, exactly as Open-FDD's hook calls it) and Open-FDD's pager. The snapshot in both cases is the sha256 of that Turtle, which is what Open-FDD reports, so switching source never rebuilds the model and a rebuild happens only when tags change. The check repeats every 5 minutes while the tab is open, and the first page alone answers an unchanged snapshot, so Open-FDD sees at most one short `rdf` run per 5 minutes per open tab. Open-FDD's 5.0.22 nf-app has no persistent graph or SPARQL server: its `rdf` and `sparql` hooks build the graph per run, so the `rdf` hook is the cheapest read. No SPARQL is run against it and nothing is written to it. The tests run this client against Open-FDD's real `rdf` hook code (`tests/fixtures/open-fdd/`, test-only) on a fake NF: alone, alongside, Open-FDD removed and reinstalled mid-session, hung, and upgraded to an unknown answer.


## D27. Optional bench simulator is off until a confirm phrase

The `sim` hook exists so a bench station can show the functional test graphic on fake AHU / VAV / reheat data. It defaults to a no-op. Creating local objects requires `enableSimulator` and the exact phrase `CREATE_LOCAL_SIM`. Creates go through `POST /api/v1/bacnet/local` with no uuid, instance numbers start at 8000 and skip anything already in use, and an instance whose name this hook did not choose is never overwritten. The hook does not arm the trigger and does not write to Open-FDD or to real BACnet devices.

