# nf-hvac-functional-test

A Normal Framework (NF) app that runs automated HVAC functional tests on air handling units (AHUs), with an optional VAV max-cooling-airflow step. It overrides equipment into defined test states, captures higher-rate data tagged with run and step IDs, and always releases every override it wrote.

> Status: v0.1 is implemented. Dry-run is the default. See [docs/INSTALL.md](docs/INSTALL.md) and [docs/OPERATIONS.md](docs/OPERATIONS.md).

## What it does

1. **AHU functional test.** Puts one AHU through a fixed sequence: baseline, full recirculation (OA damper and both coil valves closed), and optionally 100% outside air when economizer conditions are suitable. Holds each step for an adjustable time.
2. **Optional VAV max-cooling-airflow step.** Keeps the AHU in a test state and drives VAV boxes to maximum cooling airflow for an adjustable time (default 30 min), using one of three strategies: toggle a single BAS point, write a per-box flush-mode point, or write each box's airflow setpoint to its cooling maximum. Boxes that cannot be driven are skipped and reported.
3. **Data capture.** Samples the involved points at a higher rate during the test window into a dedicated NF layer, and writes a run manifest with step timestamps so SQL tools can label the data. Analysis is out of scope.
4. **Safety.** Dry-run by default, writes at a configurable BACnet priority (default 8), NF command contexts with a short lease and keepalive, a persisted override ledger, interlocks, and release on end, abort, timeout and restart.

5. **Scheduled trigger.** An NF scheduled hook checks a stored recurrence (weekly, nth weekday, last weekday of the month, or one-off) in the site timezone, limited to weekly test windows and skipped on occupancy or holidays from an NF schedule. It is off by default. Dry-run mode rehearses on schedule with no writes. Live runs need an explicit arm step in the page.
6. **Operator page.** A static page shows the run state machine with countdowns, the schedule editor and weekly grid, the points each step reads and writes on an air path diagram, active NF commands with their expiry, and run history. Open it with `?demo=1` to run it on fixture data with no station.
7. **Functional test graphic (commissioning view).** A passive 3D view of each air-handling system the site model contains (three.js, rendered in the browser). It shows live NF values — damper positions, duct static, valves, fan speed, temperatures, airflow — drawn only from the 223P model (N VAV boxes, hydronic plant and pipes when the model has them). Missing components are not invented. A deterministic sim runs only with `?demo=1`. The live graphic has no control sliders; the only input is the hold duration when you start a test.
8. **What can be tested, and a VAV max-cooling test.** A panel lists each piece of equipment and the tests it supports, including the override strategy each VAV box will use (writable airflow setpoint, boolean flush / max-flow, or enumerated box mode) and what is missing when a box cannot be tested. The first built-in test commands every testable VAV on the selected air handler to its cooling maximum for 15, 30 or 60 minutes, then flags deficiencies (starved box, damper open but low flow, duct static not maintained, fan at 100%). A prominent **Functional test ACTIVE** banner with per-system and site-wide Abort-and-release is shown while a run is in progress. The page can present many air handlers from one plugin install; unmapped VAVs sit in an Unassigned group and are not testable until they have a feed relationship.
9. **Optional bench simulator.** A `sim` hook can create new local BACnet objects on a bench station so the graphic has fake AHU / VAV / reheat data to display. It is off by default and stays a no-op until `enableSimulator` is true and `simulatorConfirm` is the phrase `CREATE_LOCAL_SIM`. See [docs/SIMULATOR.md](docs/SIMULATOR.md).

### Model source and Open-FDD

NF's Haystack tags are the source of truth: the graphic's 223P model is derived from them on every build (tags → Open-FDD role per the roles file's binding rules → the 223P pattern of that role), never hand-edited or stored. When the Open-FDD app is installed on the same NF, the page reads Open-FDD's own graph through its read-only `rdf` hook instead of building a second one; when Open-FDD is absent, erroring or slow (5 s timeout, re-checked every 5 minutes while the tab is open) it builds the same Turtle from NF's point records with a vendored, unmodified copy of Open-FDD's `model.js`, so both paths give the same snapshot and the model is rebuilt only when tags change. One graph build is cached in the browser, no RDF validation runs at runtime (that stays in CI, as in Open-FDD), and nothing here writes to Open-FDD's data.

Each plugin works alone or together: neither needs the other, and installing, removing or upgrading Open-FDD needs no reconfiguration here.

Point roles use ASHRAE 223P-derived snake_case names (same convention as Open-FDD). The test plan is built from the equipment model. Haystack tags are the model path. The hooks still refuse Turtle input (D19); Oxigraph 0.5.13 is vendored for the page's graphic only, and nothing runs OntoEnv or Shifty or fetches ontologies at runtime. A point is writable only when the model marks it writable. No site, equipment or point names are hard-coded.


## VAV override strategies

Sites can mix boxes whose airflow setpoints are BACnet-writable with boxes that only expose a boolean flush / max-flow point, or a multistate / enumerated box-mode point. The plugin does not hard-code one write method.

Each VAV is assigned a small strategy module from the bound data model, or from an optional per-box `vav_override` object in the site config:

| Strategy id | What it writes | Typical when |
| --- | --- | --- |
| `write_airflow_setpoint` | The box's `discharge_air_volume_flow_rate_setpoint` to its cooling maximum, then release | The setpoint is writable |
| `toggle_boolean` | A boolean point (default `purge_operating_mode_command`) to a configured on/off value | The box has a flush or max-flow flag, not a writable airflow setpoint |
| `set_multistate` | An enumerated / numeric mode point to a configured value, then a release value | The box exposes a mode enum |
| `unsupported` | Nothing | No usable write path; the box is listed as not testable with the missing points |

Legacy plan names `airflow_setpoint`, `flush_point` and `bas_toggle` still resolve (`bas_toggle` is the older shared AHU-level write, not a per-box write). Auto-detect prefers a writable airflow setpoint, then a per-box boolean, then a mode enum. An explicit `vav_override` always wins. Abort and guaranteed release undo whatever that strategy commanded.

A vendor-neutral example (vendor A = writable setpoint, vendor B = boolean flush, a third box = enumerated mode) is in `docs/mixed-vendor-vav-overrides.json`.

## Development

Requires Node.js 20 or newer (CI runs 20 and 22). Tests use `node:test` (`tests/*.test.mjs`) and do not open network connections. The layout follows the Open-FDD NF app: `hooks/*.js` with `hooks/lib/`, a flat `static/` page with `static/vendor/` (ECharts, Oxigraph 0.5.13, three.js 0.170.0, Open-FDD's `model.js` and `paging.js`), `tests/` with `tests/fixtures/`, and `types/`.

```bash
npm ci
npm test
npm run lint
npm run typecheck
npm run coverage
npm run validate:examples
npm run scan
npm run build:demo     # regenerate static/demo-data.js after plan changes
npm run build:roles    # regenerate static/roles-223p.js from vendor/roles/openfdd-roles.json
```

To view the page without a station, serve `static/` with any static file server and open `index.html?demo=1`.

`dry_run` defaults to true. A live write also needs `confirm_live` on the start request. BACnet priority defaults to 8 and must be an integer from 3 to 16. Priorities 1 and 2 are rejected.

Site policy is validated against `schema/site-config.schema.json`. See `examples/site-config.example.json`. Haystack role tag mappings are projected from `vendor/roles/openfdd-roles.json` (`schema/haystack-role-map.json` is that projection). The Open-FDD pin is `schema/openfdd-roles.pin.json`: version `1.1.0-draft.1`, commit `49d44e23f8be7da7aa34d10ff67cd50dee13d51b`, not the `v5.0.22` tag. `npm run roles:sync` fails if those role names drift. The shared Turtle role-file pin is `schema/shared-role-file.pin.json`. Offline validation of RDF models is a CI step (`rdflib==7.6.0`, `ontoenv==0.6.4`, `pyshifty==0.6.0`) and is not part of the NF hook. See `docs/superpowers/plans/2026-11-26-rdf-alignment.md`.

## Documents

- [docs/DESIGN.md](docs/DESIGN.md): sequence, state machine, config schema, data logging, safety, NF integration, test plan.
- [docs/INSTALL.md](docs/INSTALL.md): install from git, options, and the recommended write guardrail.
- [docs/OPERATIONS.md](docs/OPERATIONS.md): dry-run rehearsal, lab checklist, and `NEEDS_ATTENTION`.
- [docs/sql-examples.md](docs/sql-examples.md): label trends with manifest step windows.
- [docs/DECISIONS.md](docs/DECISIONS.md): departures from the design.
- [docs/CURSOR_PROMPT.md](docs/CURSOR_PROMPT.md): build prompt for a Cursor cloud agent (v0.1).
- [docs/MOVE_TO_NF_ORG.md](docs/MOVE_TO_NF_ORG.md): checklist for the move to the normalframework org.

## License

Apache-2.0. See [LICENSE](LICENSE).
