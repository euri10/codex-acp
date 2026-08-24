# Account limits extension

This experimental ACP extension exposes account-level capacity without parsing `/status` text or coupling clients to Codex App Server payloads. Account limits belong to the authenticated provider account, not an ACP Session.

## Capability negotiation

The agent advertises version 1 under `agentCapabilities._meta` in its `initialize` response:

```json
{
  "agentCapabilities": {
    "_meta": {
      "io.github.euri10.louiselm": {
        "accountLimits": {
          "version": 1,
          "readMethod": "_io.github.euri10.louiselm/account_limits/read",
          "updatedMethod": "_io.github.euri10.louiselm/account_limits/updated"
        }
      }
    }
  }
}
```

Both custom methods follow ACP's underscore-prefix rule. Clients that do not recognize the capability can ignore it and its notifications.

## Complete snapshot

The read request takes an empty object. Its response and every update notification use the same complete shape:

```json
{
  "defaultBucketId": "codex",
  "buckets": [
    {
      "id": "codex",
      "label": "Codex",
      "windows": [
        {
          "usedPercent": 82,
          "windowDurationMins": 300,
          "resetsAt": 4102444800
        }
      ],
      "planType": "plus",
      "credits": {"balance": 7.5, "unlimited": false}
    }
  ],
  "resetCredits": {"availableCount": 1}
}
```

`buckets` is always present. Bucket IDs are stable metered-limit IDs; labels are optional presentation text. Every window contains an exact duration, Unix reset timestamp in seconds, and consumed percentage. Optional fields are omitted when unavailable rather than represented by invented defaults. An empty `buckets` array, an explicit top-level `unlimited: true`, and a request failure are distinct outcomes.

The adapter deduplicates the App Server's legacy default view against its multi-bucket view by limit ID. It also converts reset-credit `bigint` counts and string credit balances into JSON numbers only when safe.

## Rolling updates

Codex App Server's `account/rateLimits/updated` payload is sparse. The adapter merges non-null fields into the last authoritative `account/rateLimits/read` result, then publishes a complete snapshot through `_io.github.euri10.louiselm/account_limits/updated`. It does not publish a rolling update before the first successful read.
