# Open-FDD shared page modules (vendored, unmodified)

Copied byte for byte from the Open-FDD NF app at `release/5.0.22`
(commit 0cea0bc363191c9b12165f5001d0de487e41f330, `nf-app/static/`). MIT, see LICENSE.

| File | sha256 | Used for |
|---|---|---|
| model.js | 862d6b9ff3af5166dd005c4e8df68e90a216f2e6f2a7e323391e2b24c9f3c188 | `toPoint`, `modelToTurtle`, `rdfBaseOf`: NF tags to the same Haystack Turtle Open-FDD builds |
| paging.js | a9f6d3ad3dd1500b1bdf577222342b832d5a6c2edb97d396722edb94c61e34dc | `OfddPaging.pageAll`: the NF point/query pager Open-FDD uses |

Do not edit. To update, copy the files from a newer Open-FDD release and update the pins in
`tests/model-source.test.mjs`.
