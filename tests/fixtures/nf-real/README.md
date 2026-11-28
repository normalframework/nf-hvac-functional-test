# Recorded Normal Framework 3.10.11 responses

Each `*.json` is one recorded exchange: `{ id, request: {method, path, body?}, response: {status, contentType, body}, note? }`.
They were captured from a live NF 3.10.11 (single node, auth off) running simulated points only, then scrubbed:
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
| `point/query` | no `pageSize` returns zero points (and the full `totalCount`); `uuid`, `uuids`, `equipRef` and other unknown fields are ignored; only `structuredQuery.field {property, text}` filters; `nextPageToken` is `""` |
| `point/points` | answers `{results:[{uuid, success, newVersion, taskUuid}]}`; a write with no base layer is accepted and applies nothing; attrs merge |
| `points/data` | `POST /api/v1/points/data` with `{points:[{uuid, values:[{ts, real}]}]}` answers `{success, taskUuid}` |
| not NF routes | `/api/v1/data`, `/api/v1/point/upsert`, `/api/v2/bacnet/write`, `/api/v2/bacnet/read` all answer 405 |
| BACnet read | `GET /api/v1/bacnet/readproperty` with `device_address.mac` + `device_address.port_id`; errors are in-band 200 `{error:{errorClass, errorCode}}` |

Still mock-only (no recording could be made): a successful command write on a driver-backed point (local simulated
objects have no driver), the `commands/read` success row, `activeWrites` rows, the zombie row shape, the BACnet
priority array read, `commands/clear`, and any real message text for guardrail or priority rejections.
The fake's `MOCK_ONLY_ROUTES` lists the routes it serves that real NF does not.

To add a recording: query the live NF, scrub with the rules above, write the file with a unique `id` equal to its
file name, then add a replay to the contract test.
