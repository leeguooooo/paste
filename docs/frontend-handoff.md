# Frontend Handoff (Gemini)

## 1. Base Rules

- Base URL: `/v1`
- Required headers for all business APIs:
  - `x-user-id`
  - `x-device-id`
- Response envelope:
  - Success: `{ ok: true, data: ... }`
  - Error: `{ ok: false, code, message }`

## 2. Primary Screens Mapping

- Clipboard list page
  - `GET /v1/clips`
  - Query options: `q`, `tag`, `favorite=1`, `cursor`, `limit`
- Create clip
  - `POST /v1/clips`
- Edit/favorite/tag/update clip
  - `PATCH /v1/clips/:id`
- Soft delete clip
  - `DELETE /v1/clips/:id`
- Tag list / create / delete
  - `GET /v1/tags`
  - `POST /v1/tags`
  - `DELETE /v1/tags/:id`
- Multi-device sync
  - Pull: `GET /v1/sync/pull?since=...`
  - Push: `POST /v1/sync/push`

## 3. Recommended Frontend Data Flow

- Initial load:
  - request `GET /v1/clips?limit=50`
  - store `nextCursor`
- Infinite scroll:
  - request `GET /v1/clips?cursor=<nextCursor>&limit=50`
- Search:
  - debounce 250-400ms
  - request `GET /v1/clips?q=<keyword>`
- Favorite toggle:
  - optimistic update UI
  - send `PATCH /v1/clips/:id` with `{ isFavorite, clientUpdatedAt: Date.now() }`
- Delete:
  - optimistic hide
  - send `DELETE /v1/clips/:id` with `{ clientUpdatedAt: Date.now() }`
- Tag filter:
  - request `GET /v1/clips?tag=<name>`

## 4. Sync + Conflict Handling

- Push local changes in batches to `POST /v1/sync/push`
- If response contains `conflicts`, replace local item with server item from `conflicts`
- Pull remote changes by `since` cursor:
  - `GET /v1/sync/pull?since=<localSince>`
  - apply `changes`
  - update local cursor to `nextSince`

## 5. Example Payloads

Create clip:

```json
{
  "type": "text",
  "summary": "meeting notes",
  "content": "todo 1, todo 2",
  "tags": ["work", "daily"],
  "isFavorite": false,
  "clientUpdatedAt": 1760000000000
}
```

Patch clip:

```json
{
  "isFavorite": true,
  "tags": ["work", "important"],
  "clientUpdatedAt": 1760000000123
}
```

Sync push:

```json
{
  "changes": [
    {
      "id": "clip_xxx",
      "summary": "new value",
      "clientUpdatedAt": 1760000000999
    }
  ]
}
```

