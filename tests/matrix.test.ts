import { Octokit, } from "octokit";
import { createAppAuth } from "@octokit/auth-app";
import { beforeAll, describe, it } from "vitest";
import _ from 'lodash';
import 'lodash.product';
import { setTimeout } from 'node:timers/promises';
import { createMainBranch, createFeatureBranch, createPullRequest, upsertRuleset } from "../src";

const apptokit = new Octokit({
  authStrategy: createAppAuth,
  auth: {
    appId: 1178750,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
    installationId: 65717473
  }
});

const tokentokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

const mergeMethods = ['MERGE'];
const conflictings = [true, false];
const minEntrieses = [1, 2];
const maxEntrieses = [1, 2];
const maxBuildses = [1, 2];
const groupingStrategies = ['ALLGREEN', 'HEADGREEN'];
const delays = [0, 15];
const waitMinuteses = [1];

const branches = await tokentokit.paginate(tokentokit.rest.repos.listBranches, {
  owner: '0x5b-org',
  repo: 'test-github-merge-queues'
});

const matrix = _.product<any>(mergeMethods, conflictings, conflictings, minEntrieses, maxEntrieses, maxBuildses, groupingStrategies, delays, waitMinuteses).filter(([, conflicting1, conflicting2, minEntries, maxEntries, maxBuilds]) => {
  // Filter out cases where maxBuilds is greater than maxEntries
  if (maxBuilds > maxEntries) return false;
  // Filter out cases where feature 1 and feature 2 are both conflicting
  if (conflicting1 && conflicting2) return false;
  // Filter out cases where minEntries is greater than maxEntries
  if (minEntries > maxEntries) return false;
  else return true;
});

describe.concurrent.for(matrix)('Merge Queue Workflow (mergeMethod: %s, conflicting 1: %s, conflicting 2: %s, minEntries: %s, maxEntries: %s, maxBuilds: %s, groupingStrategy: %s, delay: %s, waitMinutes: %s)', async ([mergeMethod, conflicting1, conflicting2, minEntries, maxEntries, maxBuilds, groupingStrategy, delay, waitMinutes]) => {
  const branchPrefix = `merge-queue/mergeMethod/${mergeMethod}/conflicting1@${conflicting1}/conflicting2@${conflicting2}/min-entries@${minEntries}/max-entries@${maxEntries}/max-builds@${maxBuilds}/grouping-strategy@${groupingStrategy}/delay@${delay}/wait-minutes@${waitMinutes}`;

  let pulls: Awaited<ReturnType<Octokit['rest']['pulls']['create']>>['data'][];
  let timeOrigin: number;
  let mainSha: string;

  // Cleanup
  beforeAll(async () => {
    // Delete branches
    for (const branchType of ['main', 'feature-1', 'feature-2']) {
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

  // Setup
  beforeAll(async () => {
    await upsertRuleset(apptokit, branchPrefix, {
      merge_method: mergeMethod as 'MERGE' | 'SQUASH' | 'REBASE',
      min_entries_to_merge: minEntries,
      max_entries_to_merge: maxEntries,
      max_entries_to_build: maxBuilds,
      min_entries_to_merge_wait_minutes: waitMinutes,
      grouping_strategy: groupingStrategy as 'ALLGREEN' | 'HEADGREEN',
      check_response_timeout_minutes: 5
    });

    mainSha = await createMainBranch(apptokit, branchPrefix);

    // Create PRs
    pulls = await Promise.all([1, 2].map(async (feature) => {
      const message = ((feature === 1 && conflicting1) || (feature === 2 && conflicting2)) ? ' (conflicting)' : undefined;

      await createFeatureBranch(apptokit, branchPrefix, feature.toString(), message);
      return createPullRequest(apptokit, branchPrefix, feature.toString());
    }));

    // Wait for the PR checks to be skipped
    await setTimeout(5_000);

    timeOrigin = Date.now();

    // Merge PR 1
    await tokentokit.graphql(`
      mutation ($pullRequestId: ID!) {
        enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) {
          clientMutationId
        }
      }
    `, {
      pullRequestId: pulls[0].node_id
    });

    // delay between PR merging
    await setTimeout(delay * 1000);

    // Merge PR 2
    await tokentokit.graphql(`
      mutation ($pullRequestId: ID!) {
        enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) {
          clientMutationId
        }
      }
    `, {
      pullRequestId: pulls[1].node_id
    });
  }, 80_000);

  it('the merge queue should be empty', { retry: 40 }, async ({ expect, onTestFailed }) => {
    onTestFailed(async () => await setTimeout(5_000));
    
    const queue = await tokentokit.graphql(`
      query($owner: String!, $name: String!, $queue_branch: String!) {
        repository(owner: $owner, name: $name) {
            mergeQueue(branch: $queue_branch) {
                entries(first: 10) {
                  nodes {
                    id
                  }
                }
            }
        }
    }`, {
      owner: '0x5b-org',
      name: 'test-github-merge-queues',
      queue_branch: `${branchPrefix}/main`
    }) as any;

    expect(queue.repository.mergeQueue.entries.nodes.length).toBe(0);

    await setTimeout(2_000);
  });

  it('PR 1 state should meet expectations', async ({ expect }) => {
    const { data: pull } = await tokentokit.rest.pulls.get({
      owner: '0x5b-org',
      repo: 'test-github-merge-queues',
      pull_number: pulls[0].number
    });

    const mergedAt = new Date(pull.merged_at!);
    const timeDiff = Math.floor((mergedAt.getTime() - timeOrigin) / 20_000) * 20;

    expect({ isMerged: pull.merged, mergedAt: pull.merged ? timeDiff : undefined }).toMatchSnapshot();
  });

  it('PR 2 state should meet expectations', async ({ expect }) => {
    const { data: pull } = await tokentokit.rest.pulls.get({
      owner: '0x5b-org',
      repo: 'test-github-merge-queues',
      pull_number: pulls[1].number
    });

    const mergedAt = new Date(pull.merged_at!);
    const timeDiff = Math.floor((mergedAt.getTime() - timeOrigin) / 20_000) * 20;

    expect({ isMerged: pull.merged, mergedAt: pull.merged ? timeDiff : undefined }).toMatchSnapshot();
  });

  it('the main branch changes should meet expectations', async ({ expect }) => {
    const { data: mainDiff } = await tokentokit.rest.repos.compareCommitsWithBasehead({
      owner: '0x5b-org',
      repo: 'test-github-merge-queues',
      basehead: `${mainSha}...${branchPrefix}/main`
    });

    expect(mainDiff.commits.map(c => c.commit.message)).toMatchSnapshot();
  });
});
