# Install

Install the app from this git repository into a Normal Framework instance that can run a Node.js app. The minimum version in `app.json` is a floor that has not been verified on a lab system (see design section 11).

```bash
git clone <repository-url> nf-hvac-functional-test
cd nf-hvac-functional-test
npm ci --omit=dev
```

Point the NF app installer at this directory. The app id is `nf-hvac-functional-test`. NF 3.10 derives an app's id from its name (lower case, anything that is not a letter or digit becomes `-`) and ignores the `id` it is sent, so `name` in `app.json` is `nf-hvac-functional-test` too: any other name installs under a different id and the page URL, hook URLs and docs below stop matching. The page title still reads "HVAC functional test".

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `siteConfig` | empty | JSON site policy. Validate it before enabling a run. |
| `enabled` | true | When false, the 10 second tick and the scheduled trigger do nothing. |
| `logLevel` | info | `debug`, `info`, `warn`, or `error`. |
| `enableSimulator` | false | When true **and** `simulatorConfirm` is `CREATE_LOCAL_SIM`, the `sim` hook creates new local BACnet objects for a fake bench system. Leave false on a normal install. |
| `simulatorConfirm` | empty | Must be exactly `CREATE_LOCAL_SIM` to allow those creates. See [SIMULATOR.md](SIMULATOR.md). |

`dry_run` inside `siteConfig` defaults to true. A live run also needs `confirm_live` on the start action.

The hook reads `siteConfig` and builds the plan from those point uuids. It does not query every point on the site. A binding query must include `equip_ref`. The on-box API base URL is the `nfBaseUrl` option or `NF_BASE_URL`, otherwise `http://127.0.0.1:8080`. State is written under `local/` (or `NF_HVAC_STATE_DIR`).

## Write guardrail

Deny writes by default. Add one allow rule for this app's API key, and clamp percent points to 0 through 100. The app still refuses BACnet priorities 1 and 2 and still defaults to priority 8.

Hooks:

- `tick` runs every 30 seconds (`DTSTART:20260101T000000Z` and `RRULE:FREQ=SECONDLY;INTERVAL=30`) with an 8 second invoke timeout, so a tick cannot overlap itself.
- `admin` is on request: `start`, `abort`, `status`, `retry_release`, `acknowledge`, `config validate`, `config discover`.
- `trigger` runs every minute (`DTSTART:20260101T000040Z` and `RRULE:FREQ=MINUTELY;INTERVAL=1` on separate lines), offset from `tick` and `sim`. It starts a run only when the stored rule is due. See below.
- `sim` runs every 120 seconds (`DTSTART:20260101T000008Z` and `RRULE:FREQ=MINUTELY;INTERVAL=2`) with a 20 second invoke timeout, starting just after a tick finishes so the two do not overlap. It is a no-op unless `enableSimulator` and `simulatorConfirm` are set as above. It creates only new local objects (no uuid on `POST /api/v1/bacnet/local`), tags them in small rotating batches, and does not arm the trigger or touch Open-FDD.

## Scheduled trigger

The trigger settings live in `local/trigger.json` and are edited from the page (admin hook action `trigger`). A fresh install is `disabled`.

- `disabled`: the trigger hook records nothing and starts nothing.
- `dry_run`: due occurrences start a dry run. No writes, whatever the site config says.
- `armed`: due occurrences start a live run. Arming takes a checkbox and typing `ARM` in the page. The site config must also have `dry_run: false`, or the run stays a rehearsal. Saving a changed rule, window, blackout or which systems the schedule covers puts the trigger back to `dry_run`. The Schedule tab can be site-wide or limited to selected air handlers, with an optional stagger between systems.

The rule is evaluated in its own IANA timezone, so a noon test stays at noon across daylight saving changes. A due occurrence is also skipped when it falls outside the weekly test windows, when a run is already active or queued, or when the blackout NF schedule is occupied or has a matching special event. If that schedule cannot be read, the occurrence is skipped (`blackout_schedule_unavailable`).

The trigger hook reads the blackout schedule with `GET /api/v1/schedules/{uuid}`. Check that the app's API key can read schedules on your NF version before relying on the blackout.

## Page

The page is served from `static/` at `/api/v1/apps/static/nf-hvac-functional-test/`. It calls the `admin` hook for status, plan preview and trigger edits, `GET /api/v2/command` for active commands, `GET /api/v1/schedules` for the blackout schedule, and the hook run list for history. It writes nothing except the operator actions (abort, retry release, acknowledge, trigger edits). If the hooks cannot be reached it shows STATUS UNKNOWN. `index.html?demo=1` runs the page on fixture data and sends nothing.

The Functional test graphic tab reads `POST /api/v1/point/query` (model layer, then each site's default layer) and, when the Open-FDD app is installed, starts Open-FDD's read-only `rdf` hook. It needs no configuration and no Open-FDD install. The page CSP allows `'wasm-unsafe-eval'` for Oxigraph's WebAssembly build.
