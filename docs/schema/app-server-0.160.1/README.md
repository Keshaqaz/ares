# Account RPC schema evidence

Generated without credentials using `codex-cli 0.160.1`:

```sh
CODEX_HOME=/tmp/schema-only codex app-server generate-ts --out /tmp/schema-output --experimental
```

These files are selected unmodified schema excerpts, not a standalone TypeScript package.
`RateLimitResetCreditsSummary.availableCount` is generated as `bigint`; JSON transports
serialize a number. The runtime refuses integers outside JavaScript's safe range.
Version, tag commit and Linux release checksum: `runtime-lock.json`.
