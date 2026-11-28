# Bench simulator (optional)

An optional `sim` hook can create **new** local BACnet objects on a bench Normal Framework station and keep their present values moving, so the functional test graphic and the "what can be tested" panel have something to show without a live plant.

It is **off by default**. Installing the app does not create any objects and does not write to any point. Enable it only on a bench station that should carry fake data.

## Safety

- The hook is a no-op unless both are set in the app options:
  - `enableSimulator` = true
  - `simulatorConfirm` = `CREATE_LOCAL_SIM` (exact phrase)
- It only talks to `GET /api/v1/bacnet/configuration`, `GET|POST|PATCH /api/v1/bacnet/local`, and `POST /api/v1/point/upsert` for tags of objects it owns.
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

Creates are batched (12 per 10-second tick) so the hook stays inside its invoke timeout. Present values are patched only after the create backlog is clear, and only on objects whose names already belong to this hook.

## Enabling on a bench station

1. Install this app. Leave `enableSimulator` false and `simulatorConfirm` empty. Confirm the Open-FDD app (if present) is unchanged and the functional-test trigger is `disabled` or `dry_run`.
2. Set `enableSimulator` to true and `simulatorConfirm` to `CREATE_LOCAL_SIM`.
3. Wait for the `sim` hook ticks. New local objects appear under NF's BACnet server; the graphic tab of this app should list the two simulated air handlers.
4. To stop creating or updating, clear `simulatorConfirm` or set `enableSimulator` to false. Existing `nfft-sim.*` local objects are left in place (the hook does not delete them).

The page is at `/api/v1/apps/static/nf-hvac-functional-test/` on the station (Graphic tab). `?demo=1` still runs the in-browser fixture and does not need this hook.

## Related issue

Tracked as part of the functional test graphic work in the repository issues (demo fixture and optional bench-station install plan).
