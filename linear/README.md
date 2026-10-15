# Native TestFlight feedback to Linear

This deterministic action reuses TestFlight PM's Apple and Linear clients to import original screenshot and crash feedback into a selected Linear project. It does not invoke an LLM or analyze the application source.

```yaml
permissions:
  contents: read
concurrency:
  group: testflight-feedback
  cancel-in-progress: false
jobs:
  feedback:
    runs-on: ubuntu-latest
    steps:
      - uses: OWNER/testflight-pm/linear@COMMIT_SHA
        with:
          testflight_issuer_id: ${{ secrets.TESTFLIGHT_ISSUER_ID }}
          testflight_key_id: ${{ secrets.TESTFLIGHT_KEY_ID }}
          testflight_private_key: ${{ secrets.TESTFLIGHT_PRIVATE_KEY }}
          testflight_bundle_id: com.example.app
          linear_api_token: ${{ secrets.LINEAR_API_TOKEN }}
          linear_team_id: TEAM_UUID
          linear_project_id: PROJECT_UUID
          require_triage: 'true'
          dry_run: 'true'
```

Replace `OWNER` and `COMMIT_SHA` with the repository and immutable revision you reviewed. The action currently supports Linux x64 runners and installs Bun 1.3.0 plus dependencies from the frozen upstream lockfile. No checkout of the consuming application is required.

The private key input takes the raw PEM contents of the `.p8` file, **not base64**. This matches the configuration loader. Keep credentials in Actions secrets.

`dry_run` defaults to `true`: preview performs reads but never uploads files, creates issues, or adds comments. Clear it only after verifying access and destination. `require_triage` defaults to `true`: the team must have Triage enabled, and the project must belong to that team. The action sets the actual Triage state ID; it does not enable Triage itself. With `require_triage: 'false'`, Linear applies its normal default status.

The default lookback is seven days. Supply `since` as an ISO timestamp for backfills or recovery after longer outages. Schedule the consuming workflow at the interval you need and serialize all runs for the same app/team. Running multiple independent importers concurrently is not supported.

## Repeat runs and original evidence

Duplicate lookup matches the TestFlight ID metadata row, includes archived issues and all result pages, and aborts on lookup errors. A repeat import leaves an existing issue unchanged, including comments and its current project/status. There is no local processed-state cache that can discard failures. Do not remove the TestFlight ID row from imported issues.

Screenshots and available detailed crash logs are uploaded to Linear's private storage before issue creation. Failed downloads/uploads stop creation so a later run can retry. A failed run after a successful upload can leave an unused uploaded asset; the importer does not delete assets. Original comments, available device context, version, and build information remain in the issue. Apple list pagination and related build resources are resolved.

Upstream optional detailed-metadata/log retrieval remains best effort. If Apple has no detailed crash log, only available crash information is retained. Avoid debug logging: upstream diagnostics may contain tester text or signed URLs. The action emits `created`, `skipped`, and `preview` counts.

## Tests

Run `bun install --frozen-lockfile --ignore-scripts`, `bun test linear/regression.test.ts`, and `bun build linear/run.ts --target=bun --outfile=/tmp/testflight-linear.js`.

Tests use mocked services and do not require credentials. Live checks should verify the destination, original text, stored images, and a second import that creates neither issues nor comments. The existing root action remains available; this separate action avoids its state-cache and LLM orchestration paths.
