# Contributing

Thanks for helping improve simple-context-limiter.

## Development Setup

```bash
npm ci
npm run check
npm test
```

The package intentionally has zero runtime dependencies. Prefer Node.js built-ins and small, focused changes.

## Validation

Before opening a change, run the most relevant checks:

- `npm run check` for syntax, unit tests, and output-quality checks.
- `npm test` for unit plus local smoke coverage.
- `npm run release:check` when changing package contents, bin entrypoints, or release-facing files.

If a check is impractical on your platform, note what was skipped and why.

## Pull Request Guidelines

Keep changes narrowly scoped, document user-visible behavior in `README.md`, add or update tests for behavior changes, and avoid unrelated formatting churn.
