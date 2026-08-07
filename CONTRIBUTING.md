# Contributing

Issues and pull requests are welcome.

The test suite lives in `test/` and is excluded from the npm tarball by the `files`
allowlist in `package.json`. Plugin manifests, marketplace catalogs, assets, and CI
configuration are part of the supported distribution surface.

## Before you submit changes

1. Keep the package, lockfile, Claude/Codex/Copilot manifests, marketplaces, `server.json`,
   and npm pins synchronized — `test/version-sync.test.js` fails if any drifts.
2. Run the Codex plugin validator and `claude plugin validate .`.
3. Run `npm test` and `npm run test:pack`.
4. Update [CHANGELOG.md](CHANGELOG.md) for user-visible changes.

## Commit conventions

- One subject line, no body.
- Small commits grouped by subject.
- Version bumps land in a single final `Release X.Y.Z` commit, never mixed with feature work.

See [TECHNICAL.md](TECHNICAL.md) for architecture, the tool reference, and local development.
