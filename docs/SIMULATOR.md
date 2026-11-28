# Bench simulator (optional)

An optional `sim` hook can create **new** local BACnet objects on a bench Normal Framework station and keep their present values moving, so the functional test graphic and the "what can be tested" panel have something to show without a live plant.

It is **off by default**. Installing the app does not create any objects and does not write to any point. Enable it only on a bench station that should carry fake data.

## Safety

- The hook is a no-op unless both are set in the app options:
  - `enableSimulator` = true
  - `simulatorConfirm` = `CREATE_LOCAL_SIM` (exact phrase)
- It only talks to `GET /api/v1/bacnet/configuration`, `GET|POST|PATCH /api/v1/bacnet/local`, and `POST /api/v1/point/points` for tags of objects it owns.
- `POST /api/v1/bacnet/local` **never includes a uuid**. NF assigns the point id. Passing an existing point uuid to that API would overwrite the point; the hook refuses a body that has one.
- Analog creates include `PROP_UNITS` (NF 3.10.9 returns `You must supply a value for property PROPERTY_IDENTIFIER_UNITS` without it). Units follow BACnet engineering-unit enumerations: `%` = 98, `°C` = 62, `Pa` = 53, `L/s` = 87, otherwise 95 (`noUnits`). Binary values do not send `PROP_UNITS`.
- Scheduled hooks read app options from `ctx.config` (NF passes flat scalars or `{boolean|string}` wrappers there, not `sdk.options`).
- Instance numbers start at 8000 and skip any instance already in use. If an instance is occupied by a different object name, that row is left untouched.
- Names are prefixed `nfft-sim.` and equipment ids `nfft-sim-…`, so they do not collide with a typical site model.
- The hook never writes to a remote BACnet device, never sends a command on an existing point, and does not change Open-FDD, the functional-test trigger, or any other app.
- Leave the functional-test trigger `disabled` or `dry_run`. Do not arm a schedule against a bench sim unless you mean to.

## What it would create (dry-run plan)

The catalog is the same shape as the bundled demo fixture: two air handlers, a hot-water boiler and pump feeding the first AHU, three VAV boxes on AHU-1 (mixed override strategies), eight cooling-only VAV boxes on AHU-2, and one unassigned VAV with no `airRef`.

Approximately:

| Kind | Count (typical) | Notes |
| --- | --- | --- |
| Site record | 1 | id `nfft-sim-site` |
| Equipment (model layer) | 16 | `nfft-sim-ahu-1`, `nfft-sim-ahu-2`, VAVs, `nfft-sim-hw-boiler-1`, `nfft-sim-hw-pump-1`, unassigned VAV |
| Local BACnet objects | ~131 | analog or binary values named `nfft-sim.<point-id>` |
| Haystack tags | same points | markers, `equipRef`, `airRef` / `feeds` rewritten to the prefixed ids |

AHU-1 includes a heating coil and is served by the hot-water plant. AHU-2 has no heating coil. VAV-03 is capacity-starved in the physics (~45%) so a max-cooling run can show a deficiency.

Creates are batched (8 per run). After that, present-value patches and Haystack upserts run in smaller rotating batches (15 and 8) so a 1 GB box stays responsive. While the model layer is still missing point records (the first ticks after install) the point tag batch is 40 instead of 8, so a fresh bench is fully tagged in a few minutes; it drops back to 8 once every record exists. All tag rows, including points, are written to the `model` layer: a point row without `layer: "model"` is accepted by NF 3.10 but tags nothing. The hook runs every 120 seconds with a 20 second invoke timeout, staggered after the 30 second tick hook so the two do not overlap. The hook does not keep an in-memory history.

Haystack upserts include a `SITE` record (`nfft-sim-site`), `EQUIPMENT` records with `airRef` / `feeds` / `isFedBy`, and point tags with `siteRef` and `equipRef`. Every upsert row includes a uuid: NF 3.10 requires one on `POST /api/v1/point/points`. Points use the uuid NF assigned at create when `/api/v1/bacnet/local` has a valid one for that exact `nfft-sim.*` name; site, equipment, and any still-unlisted point use a stable UUID v5 of the id. Foreign names, including Open-FDD weather AVs, are never tagged with a uuid.


## Operating point extras

For the Operating point tab the catalog also carries (code-defined in `hooks/lib/sim_opoint.js`, so the demo fixture is unchanged): `chw-pump-1` with speed, flow, loop DP, DP setpoint, kW and run points; `hw-pump-1` with the same set; AHU-1 with fan speed feedback, static setpoint, supply airflow and fan kW; nameplate attributes (`designFlow`, `designHead` or `designPressure`, `designPower`) on those; and two deliberately incomplete items, `chw-pump-2` (setpoint, kW and run only, no nameplate) and AHU-2 (no new points), which demo the "Missing data" text. Readings follow the valve demand and the fan speed on every tick. All points are `nfft-sim.` objects like the rest.

## Enabling on a bench station

1. Install this app. Leave `enableSimulator` false and `simulatorConfirm` empty. Confirm the Open-FDD app (if present) is unchanged and the functional-test trigger is `disabled` or `dry_run`.
2. Set `enableSimulator` to true and `simulatorConfirm` to `CREATE_LOCAL_SIM`.
3. Wait for the `sim` hook ticks. New local objects appear under NF's BACnet server; the graphic tab of this app should list the two simulated air handlers.
4. To stop creating or updating, clear `simulatorConfirm` or set `enableSimulator` to false. Existing `nfft-sim.*` local objects are left in place (the hook does not delete them).

The page is at `/api/v1/apps/static/nf-hvac-functional-test/` on the station (Graphic tab). `?demo=1` still runs the in-browser fixture and does not need this hook.

## Related issue

Tracked as part of the functional test graphic work in the repository issues (demo fixture and optional bench-station install plan).

## ACME building layout (default)

`simulatorLayout: office` (the default) builds the **ACME building**: a generic, one-to-one mirror of a real
two-floor office site's NF model. ACME is a public placeholder name; no real names, addresses or hosts are used.

| Equipment | Count | Notes |
|---|---|---|
| Packaged rooftop VAV unit `rtu-1` | 1 | DX cooling (capacity %), staged gas heat, OA damper, VFD supply fan; serves all 30 boxes |
| Hot-water plant `hw-plant-1` | 1 | one boiler, one VFD pump |
| Single-duct VAV with hot-water reheat | 30 | 17 on floor 1, 13 on floor 2; two controller families tag reheat differently, as on the real site |

The layout is `hooks/lib/sim_layout_office.json`; points are built by `hooks/lib/sim_office.js` (302 objects,
names `nfft-sim.<equip>.<point>`). Points the functional tests need but the real site does not have (fan status and
speed feedback, damper feedback, modulating cooling/heating valve commands, writable airflow setpoints on vendor-a
boxes, box maximum airflow, purge points on five vendor-b boxes) carry `nfftSimOnly: "true"` and are marked "sim"
in the page. Vendor-b boxes keep the real site's read-only airflow setpoint, so one max-cooling run picks a different
strategy per box: `airflow_setpoint` (22 boxes), `flush_point` / toggle_boolean (5) and unsupported (3).

**Physics** (one step per sim hook run, every minute): fan law fan (`p = s² p0 − a Q²`, 750 Pa at 10 m³/s and full
speed) with a built-in duct static loop that plays the BAS; box capacity from duct static; OA/RA mixing with a 0.2 K
mixed-air sensor offset; fan heat `ΔT = Δp / (η ρ cp)`; DX and gas heat on the supply air; zone drift; plant ΔP,
boiler firing and HW return. This is an illustrative teaching plant, labelled as such in the page and in evidence
reports, not an EnergyPlus run. `simulatorFaults: starved_box` turns on the far-box starvation deficiency.

**Open-FDD roles.** Every point also gets `roleRef`, the Open-FDD role id (catalog pinned in
`vendor/roles/openfdd-roles.json`, Open-FDD 5.0.22) matched from the same Haystack tags Open-FDD binds on
(`hooks/lib/openfdd_roles.js`). 267 of 302 points bind to a 223P-grounded role, 4 to Open-FDD extension roles
(223P has no class yet). Gaps: supply fan speed feedback, cooling capacity, heating stage command, HW pump speed
command and boiler firing rate have no Open-FDD role; vendor-a reheat (`heat,cmd`) only matches the catch-all; the HW
differential pressure would bind as `hot_water_reset_request_count` (no hot-water pressure role in the catalog yet).

## Test target: Simulation or Live

`testTarget` selects where the same hooks and plan run:

- **simulation** (default): the config the sim hook writes for its own objects (`local/sim-site-config.json`,
  `hooks/lib/sim_site_config.js`); the `siteConfig` option is ignored. Roles come from nfft's own Haystack map.
- **live**: only the reviewed `siteConfig` option. A run with live writes is refused (`sim_signoff_required`)
  unless a passed simulation run with the **same plan fingerprint** was signed off (`admin` action `signoff`). The
  fingerprint (`static/evidence.js` `planFingerprint`) covers plan steps, limits, interlocks, write policy, VAV test
  settings and per-equipment role coverage, not uuids or ids. Dry-run on live needs no sign-off. Every interlock,
  the priority check and the dry-run default are unchanged.

## Hook validation and evidence

`node scripts/sim-validate.mjs [--tests ahu.recirc,vav.max_cool] [--hold-recirc 20] [--hold-max-cool 5] [--signoff]`
runs the existing sequences through the app's own admin and tick hooks on a **local** NF only (it refuses any host
other than localhost), samples every minute and writes `evidence/evidence-<time>.json`, `.html` (standalone, inline
SVG trends, per-box strategy table, fan operating point on the fan curve) and one CSV of minute trends per sequence.
Checks: `ahu.recirc` OA damper closed, MAT = RAT within 1 K, DAT − MAT within 0–2 K fan heat; `vav.max_cool` duct
static within ±10% (min 25 Pa) of setpoint, fan speed below 95%, summed box airflow 85–110% of design, each tested box
at 90% of its maximum; plus hook checks (completed, wrote, released, no attention) and the Open-FDD app's hook runs
and FDD rows on the same model.

**Known limit (NF 3.x):** NF local BACnet objects live on the `hpl:bacnet:local` layer, which has no HPL driver, so
`/api/v2/command` cannot command them (`layer has no hpl driver`). The `nf_command` writer therefore cannot drive the
simulator directly yet; the run fails safe in precheck or on the first read (`comm_loss`) with no write. Next step:
expose the sim objects through a BACnet device NF scans (a virtual device or a small BACnet sim device on the local
Docker network), so they appear as `hpl:bacnet:1` points and the unchanged writer reaches them.
