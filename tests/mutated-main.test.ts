import { Octokit, } from "octokit";
import { createAppAuth } from "@octokit/auth-app";
import { beforeAll, describe, it } from "vitest";
import _ from 'lodash';
import 'lodash.product';
import { setTimeout } from 'node:timers/promises';
import { createMainBranch, createFeatureBranch, createPullRequest, upsertRuleset, mergeWhenReady, waitForMergeQueueChecks } from "../src";

const apptokit = new Octokit({
  authStrategy: createAppAuth,
  auth: {
    appId: 1178750,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
    installationId: 65717473
  }
});

const tokentokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

const branches = await tokentokit.paginate(tokentokit.rest.repos.listBranches, {
  owner: '0x5b-org',
  repo: 'test-github-merge-queues'
});

const branchPrefix = 'mutated-main';

describe('Without merge conflicts', () => {
  // Cleanup
  beforeAll(async () => {
    // Delete branches
    for (const branchType of ['main', 'feature-1']) {
      const branch = branches.find(branch => branch.name === `${branchPrefix}/${branchType}`);
      if (branch) {
        await apptokit.rest.git.deleteRef({
          owner: '0x5b-org',
          repo: 'test-github-merge-queues',
          ref: `heads/${branch.name}`
        });
      }
    }

    // Wait 5s for branches to be deleted
    await setTimeout(5_000);

    // Branch deletion will close any PRs
  }, 30_000);

  let pull: Awaited<ReturnType<Octokit['rest']['pulls']['create']>>['data'];

  // Setup
  beforeAll(async () => {
    await upsertRuleset(apptokit, branchPrefix, {
      merge_method: 'MERGE',
      min_entries_to_merge: 1,
      max_entries_to_merge: 1,
      max_entries_to_build: 3,
      min_entries_to_merge_wait_minutes: 1,
      grouping_strategy: 'ALLGREEN',
      check_response_timeout_minutes: 5
    });
    
    // Create main branch
    await createMainBranch(apptokit, branchPrefix);

    // Create feature branch
    await createFeatureBranch(apptokit, branchPrefix, '1');

    // Create PR and enqueue it
    pull = await createPullRequest(apptokit, branchPrefix, '1');
    
    console.log('PR created:', pull.number);
    console.log('Enabling auto-merge for PR...');
    
    // Enable auto-merge (enqueue)
    await mergeWhenReady(apptokit, pull.node_id);

    await waitForMergeQueueChecks(apptokit, branchPrefix, pull.number);
    
    // Wait a further 10s for the job to checkout the unmutated main
    console.log('Waiting for merge queue job to checkout unmutated main...');
    await setTimeout(3000);

    // Mutate main branch with a direct commit to simulate a release
    const { data: releaseCommit } = await apptokit.rest.repos.createOrUpdateFileContents({
      owner: '0x5b-org',
      repo: 'test-github-merge-queues',
      path: 'release-0.txt',
      message: 'Release 0 - Mutating main while PR is in queue',
      content: Buffer.from('Release 0').toString('base64'),
      branch: `${branchPrefix}/main`
    });
    
    console.log('Main branch mutated with release commit:', releaseCommit.commit.sha);
  }, 120_000);

  describe('when main branch is mutated while PR is in queue', () => {
    it('should merge the PR', { retry: 10 }, async ({ expect, onTestFailed }) => {
      onTestFailed(async () => { await setTimeout(5_000); });

      const { data: pr }= await apptokit.rest.pulls.get({
        owner: '0x5b-org',
        repo: 'test-github-merge-queues',
        pull_number: pull.number
      });

      expect(pr.merged).toBe(true);
    });

    it('should have run two checks', { retry: 10, timeout: 40_000 }, async ({ expect, onTestFailed }) => {
      onTestFailed(async () => { await setTimeout(5_000); });

      const runs = await apptokit.paginate(apptokit.rest.actions.listWorkflowRunsForRepo, {
        owner: '0x5b-org',
        repo: 'test-github-merge-queues',
        event: 'merge_group'
      });

      const prRuns = runs.filter(run => run.head_branch?.startsWith(`gh-readonly-queue/${branchPrefix}/main/pr-${pull.number}-`));

      expect(prRuns?.length).toBe(2);
    });
  });
});

describe('With merge conflicts', () => {
  // Cleanup
  beforeAll(async () => {
    // Delete branches
    for (const branchType of ['main', 'feature-1']) {
      const branch = branches.find(branch => branch.name === `${branchPrefix}/${branchType}`);
      if (branch) {
        await apptokit.rest.git.deleteRef({
          owner: '0x5b-org',
          repo: 'test-github-merge-queues',
          ref: `heads/${branch.name}`
        });
      }
    }

    // Wait 5s for branches to be deleted
    await setTimeout(5_000);

    // Branch deletion will close any PRs
  }, 30_000);

  let pull: Awaited<ReturnType<Octokit['rest']['pulls']['create']>>['data'];

  // Setup
  beforeAll(async () => {
    await upsertRuleset(apptokit, branchPrefix, {
      merge_method: 'MERGE',
      min_entries_to_merge: 1,
      max_entries_to_merge: 1,
      max_entries_to_build: 3,
      min_entries_to_merge_wait_minutes: 1,
      grouping_strategy: 'ALLGREEN',
      check_response_timeout_minutes: 5
    });
    
    await createMainBranch(apptokit, branchPrefix);

    // Create feature branch
    await createFeatureBranch(apptokit, branchPrefix, '1');

    // Create PR and enqueue it
    pull = await createPullRequest(apptokit, branchPrefix, '1');
    
    console.log('PR created:', pull.number);
    console.log('Enabling auto-merge for PR...');
    
    // Enable auto-merge (enqueue)
    await mergeWhenReady(apptokit, pull.node_id);

    await waitForMergeQueueChecks(apptokit, branchPrefix, pull.number);
    
    // Wait a further 10s for the job to checkout the unmutated main
    console.log('Waiting for merge queue job to checkout unmutated main...');
    await setTimeout(3000);

    // Mutate main branch with a direct commit to simulate a release
    const { data: releaseCommit } = await apptokit.rest.repos.createOrUpdateFileContents({
      owner: '0x5b-org',
      repo: 'test-github-merge-queues',
      path: 'feature-1.txt',
      message: 'Release 0 - Mutating main while PR is in queue',
      content: Buffer.from('Release 0').toString('base64'),
      branch: `${branchPrefix}/main`
    });
    
    console.log('Main branch mutated with release commit:', releaseCommit.commit.sha);
  }, 120_000);

  describe('when main branch is mutated while PR is in queue', () => {
    it('should merge the PR', { retry: 10 }, async ({ expect, onTestFailed }) => {
      onTestFailed(async () => { await setTimeout(5_000); });

      const { data: pr } = await apptokit.rest.pulls.get({
        owner: '0x5b-org',
        repo: 'test-github-merge-queues',
        pull_number: pull.number
      });

      expect(pr.merged).toBe(false);
      expect(pr.mergeable_state).toBe('dirty');
    });
  });

  it('should have run one check', { retry: 10, timeout: 40_000 }, async ({ expect, onTestFailed }) => {
    onTestFailed(async () => { await setTimeout(5_000); });

    const runs = await apptokit.paginate(apptokit.rest.actions.listWorkflowRunsForRepo, {
      owner: '0x5b-org',
      repo: 'test-github-merge-queues',
      event: 'merge_group'
    });

    const prRuns = runs.filter(run => run.head_branch?.startsWith(`gh-readonly-queue/${branchPrefix}/main/pr-${pull.number}-`));

    expect(prRuns?.length).toBe(1);
  });
});
