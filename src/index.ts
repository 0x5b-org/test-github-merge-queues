import { Octokit } from "octokit";
import { setTimeout } from "timers/promises";

export async function upsertRuleset(octokit: Octokit, branchPrefix: string, parameters: NonNullable<Extract<NonNullable<NonNullable<Parameters<Octokit['rest']['repos']['createRepoRuleset']>[number]>['rules']>[number], { type: 'merge_queue' }>['parameters']>) {
  const rulesets = await octokit.paginate(octokit.rest.repos.getRepoRulesets, {
    owner: '0x5b-org',
    repo: 'test-github-merge-queues',
    includes_parents: false
  });

  const ruleset = {
      owner: '0x5b-org',
      repo: 'test-github-merge-queues',
      name: `Merge queue (${branchPrefix}/main)`,
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
          parameters
        },
        {
          type: 'required_status_checks',
          parameters: {
            strict_required_status_checks_policy: false,
            do_not_enforce_on_create: true,
            required_status_checks: [{
              context: 'merge_queue_check',
              integration_id: 15368
            }]
          }
        }
      ],
      bypass_actors: [
        {
          // The tester app
          actor_type: 'Integration',
          actor_id: 1178750,
          bypass_mode: 'always'
        }
      ]
    } satisfies Parameters<Octokit['rest']['repos']['createRepoRuleset']>[0];

    const rulesetId = rulesets.find(r => r.name === ruleset.name)?.id;
    if (rulesetId) await octokit.rest.repos.updateRepoRuleset({ ...ruleset, ruleset_id: rulesetId });
    else await octokit.rest.repos.createRepoRuleset(ruleset);
}

export async function upsertWorkflow(octokit: Octokit, branchPrefix: string, branch: string, waitSecs: number = 10) {
  let content;
  let sha;
  
  try {
    const response = await octokit.rest.repos.getContent({
      owner: '0x5b-org',
      repo: 'test-github-merge-queues', 
      ref: `${branchPrefix}/${branch}`,
      path: `.github/workflows/workflow.yml`
    });
    
    if (Array.isArray(response.data)) throw new Error('Path is a directory, not a file');
    content = response.data;
    sha = content.sha;
  } catch (error: any) {
    // Handle 404 errors - file doesn't exist yet
    if (error.status === 404) {
      // We'll create a new file without providing a SHA
      sha = undefined;
    } else {
      // Re-throw any other errors
      throw error;
    }
  }

  const { data: update } = await octokit.rest.repos.createOrUpdateFileContents({
    owner: '0x5b-org',
    repo: 'test-github-merge-queues',
    path: `.github/workflows/workflow.yml`,
    message: 'Add workflow to main branch',
    content: Buffer.from(JSON.stringify({
      on: ['pull_request', 'merge_group'],
      jobs: {
        merge_queue_check: {
          if: 'github.event_name != \'pull_request\'',
          'runs-on': 'ubuntu-latest',
          steps: [
            { uses: 'actions/checkout@v4',
              with: { 'fetch-depth': 0 }
            },
            { run: `sleep ${waitSecs}` },
            {
              run: `! git log --format=%s origin/${branchPrefix}/main..HEAD | grep '(conflicting)'`
            }
          ]
        }
      }
    })).toString('base64'),
    branch: `${branchPrefix}/${branch}`,
    sha: sha
  });

  return update;
}

export async function createMainBranch(octokit: Octokit, branchPrefix: string, waitSecs: number = 10): Promise<string> {
  const response = await octokit.graphql(`
    query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        defaultBranchRef {
          target {
            oid
          }
        }
      }
    }`,
    {
      owner: '0x5b-org',
      name: 'test-github-merge-queues',
    }) as any;
  
  await octokit.rest.git.createRef({
    owner: '0x5b-org',
    repo: 'test-github-merge-queues',
    ref: `refs/heads/${branchPrefix}/main`,
    sha: response.repository.defaultBranchRef.target.oid
  });

  // Push workflow to main branch
  const addWorkflow = await upsertWorkflow(octokit, branchPrefix, 'main', waitSecs);

  return addWorkflow.commit.sha!;
}

export async function createFeatureBranch(octokit: Octokit, branchPrefix: string, feature: string, commitMessage?: string) {
  const { data: branch } = await octokit.rest.git.getRef({
    owner: '0x5b-org',
    repo: 'test-github-merge-queues',
    ref: `heads/${branchPrefix}/main`
  });
  const mainSha = branch.object.sha;

  await octokit.rest.git.createRef({
    owner: '0x5b-org',
    repo: 'test-github-merge-queues',
    ref: `refs/heads/${branchPrefix}/feature-${feature}`,
    sha: mainSha
  });

  // Create dummy file
  let message = `Make feature ${feature}`;
  if (commitMessage) message += ` ${commitMessage}`;
  const { data: dummy } = await octokit.rest.repos.createOrUpdateFileContents({
    owner: '0x5b-org',
    repo: 'test-github-merge-queues',
    path: `feature-${feature}.txt`,
    message,
    content: Buffer.from('Dummy file').toString('base64'),
    branch: `${branchPrefix}/feature-${feature}`
  });

  return dummy.commit.sha!;
}

export async function createPullRequest(octokit: Octokit, branchPrefix: string, feature: string) {
  const { data: pull } = await octokit.rest.pulls.create({
    owner: '0x5b-org',
    repo: 'test-github-merge-queues',
    title: `Feature ${feature}`,
    head: `${branchPrefix}/feature-${feature}`,
    base: `${branchPrefix}/main`
  });

  return pull;
}

export async function mergeWhenReady(octokit: Octokit, pull_node_id: string): Promise<void> {
  await octokit.graphql(`
    mutation ($pullRequestId: ID!) {
      enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) {
        clientMutationId
      }
    }
  `, {
    pullRequestId: pull_node_id
  });
}

export async function queueEntries(octokit: Octokit, queueName: string) {    
  const queue = await octokit.graphql.paginate(`
    query($owner: String!, $name: String!, $queue_branch: String!, $cursor: String) {
      repository(owner: $owner, name: $name) {
          mergeQueue(branch: $queue_branch) {
              entries(first: 100, after: $cursor) {
                nodes {
                  id
                  position
                  pullRequest { number }
                  baseCommit { oid }
                  headCommit { oid }
                  solo
                  state
                }
                pageInfo {
                  endCursor
                  hasNextPage
                }
              }
          }
      }
  }`, {
    owner: '0x5b-org',
    name: 'test-github-merge-queues',
    queue_branch: queueName
  }) as any;

  return queue.repository.mergeQueue.entries.nodes;
}

// Helper function to check if merge queue checks have started for a PR
export async function waitForMergeQueueChecks(octokit: Octokit, branchPrefix: string, prNumber: number) {
  for (let i = 0; i < 6; i++) {  // Try for up to 30 seconds (6 x 5s)
    console.log(`Checking if merge queue checks started for PR-${prNumber} (attempt ${i + 1}/6)...`);
    
    // Get merge queue entries to find the correct ref
    const entries = await queueEntries(octokit, `${branchPrefix}/main`);

    // Find the entry for this PR
    const entry = entries.find(e => e.pullRequest.number === prNumber);

    if (!entry) {
      console.log(`PR-${prNumber} not found in merge queue`);
      await setTimeout(5000);
      continue;
    }

    if (!entry.headCommit) {
      console.log(`No head commit found for PR-${prNumber}`);
      await setTimeout(5000);
      continue;
    }

    // Check for checks on both the feature branch and main branch
    const { data: checks } = await octokit.rest.checks.listForRef({
      owner: '0x5b-org',
      repo: 'test-github-merge-queues',
      ref: entry.headCommit.oid
    });
    
    const featureHasChecks = checks.check_runs.length > 0;
    
    if (featureHasChecks) return checks.check_runs;
    
    await setTimeout(5000);  // Wait 5 seconds before checking again
  }
  
  console.warn(`No merge queue checks found for PR-${prNumber} after 30 seconds`);
}

// Export alias for queueEntries as queue for backward compatibility
export const queue = queueEntries;