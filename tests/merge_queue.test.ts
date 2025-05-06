import { Octokit, } from "octokit";
import { createAppAuth } from "@octokit/auth-app";
import { beforeAll, describe, it } from "vitest";
import _ from 'lodash';
import 'lodash.product';
import { setTimeout } from 'node:timers/promises';

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

const { data: main } = await tokentokit.rest.git.getRef({
  owner: '0x5b-org',
  repo: 'repository-config-testbed',
  ref: 'heads/main'
});

const rulesets = await tokentokit.paginate(tokentokit.rest.repos.getRepoRulesets, {
  owner: '0x5b-org',
  repo: 'repository-config-testbed',
  includes_parents: false
});

const branches = await tokentokit.paginate(tokentokit.rest.repos.listBranches, {
  owner: '0x5b-org',
  repo: 'repository-config-testbed'
});

const matrix = _.product<any>(mergeMethods, conflictings, conflictings, minEntrieses, maxEntrieses, maxBuildses, groupingStrategies, delays, waitMinuteses).filter(([mergeMethods, conflicting1, conflicting2, minEntries, maxEntries, maxBuilds]) => {
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

  if (maxBuilds > maxEntries) return;

  // Cleanup
  beforeAll(async () => {
    // Delete branches
    for (const branchType of ['main', 'feature-1', 'feature-2']) {
      const branch = branches.find(branch => branch.name === `${branchPrefix}/${branchType}`);
      if (branch) {
        await apptokit.rest.git.deleteRef({
          owner: '0x5b-org',
          repo: 'repository-config-testbed',
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
    // Upsert rulesets
    const rulesetUpdates = [
      {
        owner: '0x5b-org',
        repo: 'repository-config-testbed',
        name: `Merge queue (mergeMethod: ${mergeMethod}, conflicting 1: ${conflicting1}, conflicting 2: ${conflicting2} minEntries: ${minEntries}, maxEntries: ${maxEntries}, maxBuilds: ${maxBuilds}, groupingStrategy: ${groupingStrategy}, delay: ${delay}, waitMinutes: ${waitMinutes})`,
        target: 'branch',
        enforcement: 'active',
        conditions: {
          ref_name: {
            include: [`refs/heads/${branchPrefix}/main`],
            exclude: []
          }
        },
        rules: [
          {
            type: 'merge_queue',
            parameters: {
              merge_method: mergeMethod as 'MERGE' | 'SQUASH' | 'REBASE',
              min_entries_to_merge: minEntries,
              max_entries_to_merge: maxEntries,
              max_entries_to_build: maxBuilds,
              min_entries_to_merge_wait_minutes: waitMinutes,
              grouping_strategy: groupingStrategy as 'ALLGREEN' | 'HEADGREEN',
              check_response_timeout_minutes: 5
            }
          },
          {
            type: 'required_status_checks',
            parameters: {
              strict_required_status_checks_policy: false,
              do_not_enforce_on_create: true,
              required_status_checks: [{
                context: 'placeholder',
                integration_id: 15368
              }]
            }
          }
        ],
        bypass_actors: [
          {
            actor_type: 'Integration',
            actor_id: 1178750,
            bypass_mode: 'always'
          }
        ]
      }
    ] satisfies Parameters<Octokit['rest']['repos']['createRepoRuleset']>[0][];
    for (const ruleset of rulesetUpdates) {
      console.log(`Upserting ruleset ${JSON.stringify(ruleset)}`);

      const rulesetId = rulesets.find(r => r.name === ruleset.name)?.id;
      if (rulesetId) await apptokit.rest.repos.updateRepoRuleset({ ...ruleset, ruleset_id: rulesetId });
      else await apptokit.rest.repos.createRepoRuleset(ruleset);
    }

    // Create main branch
    await tokentokit.rest.git.createRef({
      owner: '0x5b-org',
      repo: 'repository-config-testbed',
      ref: `refs/heads/${branchPrefix}/main`,
      sha: main.object.sha
    });

    // Push workflow to main branch
    const { data: update } = await apptokit.rest.repos.createOrUpdateFileContents({
      owner: '0x5b-org',
      repo: 'repository-config-testbed',
      path: `.github/workflows/workflow.yml`,
      message: 'Add workflow to main branch',
      content: Buffer.from(JSON.stringify({
        on: ['pull_request', 'merge_group'],
        jobs: {
          placeholder: {
            if: 'github.event_name != \'pull_request\'',
            'runs-on': 'ubuntu-latest',
            steps: [
              { uses: 'actions/checkout@v4',
                with: { 'fetch-depth': 0 }
              },
              { run: 'sleep 10' },
              {
                run: `! git log --format=%s origin/${branchPrefix}/main..HEAD | grep '(conflicting)'`
              }
            ]
          }
        }
      })).toString('base64'),
      branch: `${branchPrefix}/main`
    });
    mainSha = update?.commit.sha!;

    // Create PRs
    pulls = await Promise.all([1, 2].map(async (feature) => {
      await tokentokit.rest.git.createRef({
        owner: '0x5b-org',
        repo: 'repository-config-testbed',
        ref: `refs/heads/${branchPrefix}/feature-${feature}`,
        sha: mainSha
      });

      // Create dummy file
      let message = `Make feature ${feature}`;
      if ((feature === 1 && conflicting1) || (feature === 2 && conflicting2)) message += ' (conflicting)';
      await tokentokit.rest.repos.createOrUpdateFileContents({
        owner: '0x5b-org',
        repo: 'repository-config-testbed',
        path: `feature-${feature}.txt`,
        message,
        content: Buffer.from('Dummy file').toString('base64'),
        branch: `${branchPrefix}/feature-${feature}`
      });

      const { data: pull } = await tokentokit.rest.pulls.create({
        owner: '0x5b-org',
        repo: 'repository-config-testbed',
        title: `Merge Queue (mergeMethod: ${mergeMethod}, conflicting 1: ${conflicting1}, conflicting 2: ${conflicting2}, minEntries: ${minEntries}, maxEntries: ${maxEntries}, maxBuilds: ${maxBuilds}, groupingStrategy: ${groupingStrategy}, delay: ${delay}, waitMinutes: ${waitMinutes})`,
        head: `${branchPrefix}/feature-${feature}`,
        base: `${branchPrefix}/main`
      });

      return pull;
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

  it('the merge queue should be empty', { retry: 30 }, async ({ expect, onTestFailed }) => {
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
      name: 'repository-config-testbed',
      queue_branch: `${branchPrefix}/main`
    }) as any;

    expect(queue.repository.mergeQueue.entries.nodes.length).toBe(0);
  });

  it('PR 1 state should meet expectations', async ({ expect }) => {
    const { data: pr1 } = await tokentokit.rest.pulls.get({
      owner: '0x5b-org',
      repo: 'repository-config-testbed',
      pull_number: pulls[0].number
    });

    expect({ isMerged: pr1.merged }).toMatchSnapshot();
  });

  it('PR 2 state should meet expectations', async ({ expect }) => {
    const { data: pr2 } = await tokentokit.rest.pulls.get({
      owner: '0x5b-org',
      repo: 'repository-config-testbed',
      pull_number: pulls[1].number
    });

    expect({ isMerged: pr2.merged }).toMatchSnapshot();
  });

  it('the main branch changes should meet expectations', async ({ expect }) => {
    const { data: mainDiff } = await tokentokit.rest.repos.compareCommitsWithBasehead({
      owner: '0x5b-org',
      repo: 'repository-config-testbed',
      basehead: `main...${branchPrefix}/main`
    });

    expect(mainDiff.commits.map(c => c.commit.message)).toMatchSnapshot();
  });
});
