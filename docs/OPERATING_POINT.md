# Operating point tab

A read-only view of every waterside pump and every air handler supply fan: the pump or fan curve, the system curve, the operating point, a model-driven schematic, a readout and a fixed-speed against variable-speed comparison. It never writes.

## What is drawn

- **Waterside** (one panel per pump equipment that is not a condenser pump): pump curve at 100 percent speed and at the current speed (affinity laws), system curve, operating point; loop schematic with the pump and VFD (Hz and percent), the loop's coil valves with live valve position, VAV reheat valves (hot water, grouped), flow meter, DP sensor and DP setpoint. Readout: flow, head, speed, power, loop DP and setpoint.
- **Airside** (one panel per air handler): fan curve, duct system curve, operating point; schematic with the fan and VFD, airflow, duct static and setpoint, and the VAV damper positions downstream. Readout: flow, total pressure, speed, power, duct static and setpoint.

Charts always render. When something is missing the panel says so in plain words and the chart stays on screen:

- `Missing data: pump speed sensor, chilled water flow sensor, ...` names the exact Haystack tags the panel needs and does not find.
- A curve without nameplate data is a normalized generic curve (axes in percent of design) labelled **ILLUSTRATIVE**; the operating point is then placed by speed alone and the readout shows measured values only.

## Where the data comes from

The same records the Functional test graphic reads (model layer, then each site's default layer). Equipment is found by marker (`pump`, `ahu`); points are resolved per equipment by 223P role through `NfftHaystackBind` and the pinned role vocabulary, and where the vocabulary has no role (pump speed, pump power, hot water flow and DP) by Haystack marker set. A role match ranks first, then the marker sets in order. Latest values are read per equipment (`equipRef`), never a site-wide poll.

| Quantity | Pump tags (chilled water shown; hot water uses `hot water`) | Fan tags |
| --- | --- | --- |
| speed | `pump speed sensor`, `pump vfd speed sensor`, else the matching `cmd` | `discharge fan vfd speed sensor`, else `... vfd speed cmd` |
| flow | `chilled water flow sensor` | `discharge air flow sensor` (else the sum of the VAV `discharge air flow sensor` points) |
| DP / static | `chilled water delta pressure sensor` | `discharge air pressure sensor` |
| setpoint | `chilled water delta pressure sp` | `discharge air pressure sp` |
| power | `pump elec power sensor`, `elec power sensor` | `discharge fan elec power sensor`, `fan elec power sensor` |
| valve | AHU `cool valve sensor` / `cmd`, `heat valve ...`; VAV `reheat cmd` | VAV `damper sensor`, else `damper cmd` |

Flow, DP and its setpoint may sit on plant equipment (chiller, boiler, header) or on a loop AHU; never on another pump. The loop is the equipment in the pump's `feeds` attribute, else every AHU that has a valve for that medium. VAVs belong to an AHU through `airRef` or `isFedBy`.

## Curves

Compute is in SI base units (m3/s, Pa, W, speed as a fraction of rated speed). Shown units are L/s, kPa or Pa, kW and Hz, with imperial (gpm, ft, cfm, in. w.c., hp) in parentheses only.

Nameplate attributes on the pump or AHU equipment record (bare numbers use the default unit; text like `16 L/s` carries its own):

| Attribute | Default unit | Meaning |
| --- | --- | --- |
| `designFlow` | L/s | design flow |
| `designHead` (pump), `designPressure` (fan) | kPa (pump), Pa (fan) | head or total pressure at the design flow |
| `designPower` | kW | shaft power at the design point; anchors the power estimate |
| `curveCoeffs` | kPa (pump) or Pa (fan), Q in L/s | `c0,c1,c2,...`: `H = c0 + c1 Q + c2 Q^2 + ...`; replaces the generic shape |
| `ratedHz`, `ratedRpm`, `etaBest` | 60 Hz, none, 0.75 pump or 0.65 fan | rating used for Hz and efficiency |

- Generic shape: `H(q) = Hd (1.25 - 0.25 q^2)` for pumps (`1.30 - 0.30 q^2` for fans), `q = Q / Qd`. Efficiency `eta(q) = etaBest (2q - q^2)`, floored at 15 percent of the best point. Power is `Q H / eta`.
- Affinity laws: `Q ~ s`, `H ~ s^2`, `P ~ s^3`. The curve at speed `s` is `s^2 H100(Q / s)`.
- System curve: `H = Hs + k Q^2`. `Hs` is the DP (or static pressure) setpoint, else the measured DP, else 30 percent of design head. `k` is fitted so the curve passes through the current point (measured flow and the curve's head at the present speed). `Hs` is limited to 90 percent of the head at that flow and the panel says so when it is.
- Without a flow sensor the point is the intersection of the curve at the present speed with a system curve through the design point (bisection).
- Fixed speed against variable speed at the same flow: a throttled fixed-speed machine runs at 100 percent and burns the extra head; a wide-open fixed-speed machine sits at the natural intersection. A measured kW anchors the model.

## On the local bench

The simulator (see `SIMULATOR.md`) adds `chw-pump-1` (full tag set and nameplate), `hw-pump-1` (full set and nameplate), AHU-1 (fan speed feedback, static setpoint, airflow, kW, nameplate) and two deliberately incomplete items: `chw-pump-2` (a standby pump with no speed, flow or DP point and no nameplate) and AHU-2 (no static setpoint and no fan power point), so the tab always shows the missing-data text.
## Design values import (lab_bundle.json)

The Operating point panels read `static/design-values.json` (`static/design-values.js`). It takes the
`lab_bundle.json` shape from the RDF/EnergyPlus sim lab (`building`, `sizing_inventory.status`, `design_values`,
`curves.fans[]` / `curves.pumps[]` with `design`, `flow_vs_pressure`, `flow_vs_power`), plus an optional
`nfft_equipment_map` (bundle equipment name to nfft equipment id). A sample is in `examples/design/lab_bundle.sample.json`.

Each value falls back in order and the panel labels its source: measured point, then nameplate attributes on the
equipment, then the design file (labelled "from EnergyPlus model" only when `sizing_inventory.status` is a real run;
`FIXTURE` and `SAMPLE` bundles are labelled as such), then the generic illustrative curve. A rising
`flow_vs_pressure` sweep is not used as a fixed-speed fan curve.
