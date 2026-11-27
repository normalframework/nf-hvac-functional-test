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

Point roles use ASHRAE 223P-derived snake_case names (same convention as Open-FDD). The test plan is built from the equipment model. Haystack tags are the model path. Turtle input is disabled until Oxigraph 0.5.13 and the shared 223P role file are vendored; the hook does not run OntoEnv or Shifty and does not fetch ontologies. A point is writable only when the model marks it writable. No site, equipment or point names are hard-coded.

## Development

Requires Node.js 20 or newer. Tests use `node:test` and do not open network connections.

```bash
npm ci
npm test
npm run lint
npm run typecheck
npm run coverage
npm run validate:examples
npm run scan
npm run build:demo     # regenerate static/js/demo-data.js after plan changes
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
