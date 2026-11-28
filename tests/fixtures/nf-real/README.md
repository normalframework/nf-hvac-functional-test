# Recorded Normal Framework 3.10.11 responses

Each `*.json` is one recorded exchange: `{ id, request: {method, path, body?}, response: {status, contentType, body}, note? }`.
They were captured from a live NF 3.10.11 (single node, auth off), then scrubbed. Most ran against simulated points only. The `bacnet__readproperty_priority_array_*`, `*_relinquish_default_*`, `*_during_command`, `commands__write_applied` and `commands__list_with_active_write` recordings came from a bench BACnet controller (one test write to one analog output at a 60 s lease, cancelled, slot confirmed empty, value restored). Scrubbed the same way:
site, host and tenant names replaced, addresses moved to `192.0.2.0/24`, hardware inventory, license ids and hook
runtime environments removed. Nothing here names a customer, a building or a person (`npm run scan` checks that).

What reads them:

- `tests/fixtures/fake/server.js` builds the fake's `platform/env` answer and its layer list from them.
- `tests/nf-real-contract.test.mjs` replays the recorded requests against the fake and compares status, content type
  and JSON shape (`tests/fixtures/nf-shape.js`), and drives `NfClient` against recorded replies.

Behaviours these recordings pin down (the fake follows them):

| Area | Real NF 3.10.11 |
|---|---|
| int64 fields | strings: command `id`, `totalCount` |
| errors | HTTP failures have EMPTY bodies: `application/grpc` for service errors (unknown layer, 404 unknown command, 409 duplicate name, bad uuid), `text/plain` 400 for decode or validation (bad JSON, an unknown request field, a duration that is not `"300s"`) |
| unknown routes | GET answers the web console (200 html); other methods answer 405 html |
| in-band errors | `commands/read` and `commands/write` answer 200 with `errors: [{point, error: {ts, message, error: {"@type", message}}}]`; there is NO `code` |
| `platform/env` | the `name` filter is ignored: all variables come back, each identified by `id` (`BACNET_PRIORITY`), `name` is a display name, the value is `integer` as a string |
| uuid lookup | there is no get-by-uuid route; `structuredQuery.field {property:"uuid", text}` finds exactly that point on any layer; every layer's record carries `hpldata` (`deviceAddress`, `property.objectId`, `hasPriorityArray`) |
| `point/query` | no `pageSize` returns zero points (and the full `totalCount`); `uuid`, `uuids`, `equipRef` and other unknown fields are ignored; only `structuredQuery.field {property, text}` filters; `nextPageToken` is `""` |
| `point/points` | answers `{results:[{uuid, success, newVersion, taskUuid}]}`; a write with no base layer is accepted and applies nothing; attrs merge |
| `points/data` | `POST /api/v1/points/data` with `{points:[{uuid, values:[{ts, real}]}]}` answers `{success, taskUuid}` |
| not NF routes | `/api/v1/data`, `/api/v1/point/upsert`, `/api/v2/bacnet/write`, `/api/v2/bacnet/read` all answer 405 (the fake answers 405 too, `REMOVED_ROUTES`). `POST /api/v1/bacnet/writeproperty` DOES exist (400 on an empty body); its request shape is unverified and it is not used |
| BACnet read | `GET /api/v1/bacnet/readproperty` with `device_address.mac` + `device_address.port_id` (+ `net`, `adr` for a routed device); errors are in-band 200 `{error:{errorClass, errorCode}}` |
| priority array | `value.array` holds 16 objects, each with an empty `array`: an empty slot is `{null:true, array:[]}`, a held analog slot `{real:12, array:[]}`. `PROP_RELINQUISH_DEFAULT` and `PROP_PRESENT_VALUE` are `{real|enumerated, array:[]}`; binary objects use `enumerated` 0/1 |
| command write slot | `POST /api/v2/command/write` accepts a request `priority` and IGNORES it: NF writes the slot named by its process-wide `BACNET_PRIORITY` (12 on a default install). The reply row and `activeWrites` row carry `systemPriority:"0"` (a command-conflict rank), `cancelOnConflict`, and no BACnet priority. `DELETE /api/v2/command/{id}` empties the slot and the present value returns to the relinquish default |

Still mock-only (no recording could be made): the `commands/read` success row, the zombie row shape, a held BINARY priority slot (expected `enumerated` 0/1; only an empty binary array was recorded), `commands/clear`, and any real message text for guardrail or priority rejections.
The fake's `MOCK_ONLY_ROUTES` lists the routes it serves that real NF does not.

To add a recording: query the live NF, scrub with the rules above, write the file with a unique `id` equal to its
file name, then add a replay to the contract test.
