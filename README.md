# Repository Config Testbed

It is not always obvious what the effect of GitHub repository configuration is.

This repository contains test cases for various GitHub Repository Configurations, so that these effects are documented.

## Test Suites

### Checks

This tests the effect of check status and conclusion on a ruleset configured to require a status check.

Based on the [test snapshots](./tests/__snapshots__/checks.test.ts.snap), we can see that:

- `conclusion`s in `['neutral', 'skipped', 'success']` are treated as `truthy`
- Other `conclusion`s are treated as `falsey`
- Check `status` does not affect how the ruleset treats the check.

### Reviews

This tests the effect of the `pull_request` ruleset parameters.

Based on the [test snapshots](./tests/__snapshots__/reviews.test.ts.snap), we can see that:

- With either of `dismiss_stale_reviews_on_push` and `require_last_push_approval` set, commits that change the diff of the PR will invalidate prior approvals.
- With `require_last_push_approval` set, users cannot 'sneak in' changes, by pushing to a pull request, then approving that pull request.

### Workflows

This tests the workflows that get triggered by Pull Requests.

Based on the [test snapshots](./tests/__snapshots__/workflows.test.ts.snap), we can see that:

- If there isn't a triggering workflow on the base branch, and the head branch contains a workflow with `pull_request_target`, then the workflow will not run.
- If the head branch doesn't contain a triggering workflow, then the workflow will not run.
- If the base branch contains a workflow with `pull_request`, and the head branch changes that to `pull_request_target`, then the workflow will not run (this was unexpected).
- The workflow will be sourced from the base branch when the workflow has `pull_request_target` in the base AND head branches of the pull request.
- Otherwise, the workflow will run, and be sourced from the head branch:
  - A new workflow with `pull_request`
  - From `pull_request` to `pull_request`
  - From `pull_request_target` to `pull_request`
  - From a workflow with an unrelated trigger (`workflow_dispatch`) to `pull_request`

## Running Locally

Some tests require multiple users (e.g. to open and approve PRs), some tests require GitHub apps (e.g. to send status checks).

To run the app locally, use the following command:

```
GITHUB_APP_PRIVATE_KEY=$(cat ~/Downloads/repository-config-tester.2025-03-14.private-key.pem) GITHUB_TOKEN=$(gh auth token --user=jonathanmorley) pnpm vitest run
```

## Extra Tests

### Non-ordered queueing

PR-1 gets enqueued (long tests)
Midway through, PR-2 gets enqueued (short tests)
Test whether:
  * PR-2 gets merged when its tests complete?
  * it waits for PR-1 to be merged (is the queue FIFO)?


### Mid-queue merge conflicts

PR-1 gets enqueued (long enough tests to enqueue 2 while its in queue)
PR-2 gets enqueued (conflicts with PR-1)
Test whether:
  * this kicks back PR-2 (and with a reason?)

