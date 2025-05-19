import { Octokit } from "octokit";
import { createAppAuth } from "@octokit/auth-app";
import { beforeAll, describe, it, expect } from "vitest";
import _ from 'lodash';
import { setTimeout } from 'node:timers/promises';
import { 
  createMainBranch, 
  createFeatureBranch, 
  createPullRequest, 
  upsertRuleset, 
  mergeWhenReady, 
  queue,
  upsertWorkflow
} from "../src";

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

const branchPrefix = 'non-ordered-queueing';

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

let _mainSha: string;
let pull1: Awaited<ReturnType<Octokit['rest']['pulls']['create']>>['data'];
let pull2: Awaited<ReturnType<Octokit['rest']['pulls']['create']>>['data'];
let mergeTimes: { [key: number]: Date } = {};

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
  
  _mainSha = await createMainBranch(apptokit, branchPrefix, 30); // Long workflow (30s)

  // Create feature branch 1 - will have long-running tests
  await createFeatureBranch(apptokit, branchPrefix, '1');

  // Create and enqueue PR-1 (long-running tests)
  pull1 = await createPullRequest(apptokit, branchPrefix, '1');
  
  console.log('PR-1 created:', pull1.number);
  console.log('Enabling auto-merge for PR-1...');
  
  // Enable auto-merge (enqueue)
  await mergeWhenReady(apptokit, pull1.node_id);
  
  // Wait for PR-1 to start processing (5 seconds should be sufficient)
  await setTimeout(5000);
  
  // Create a second main branch with short-running tests
  await upsertWorkflow(apptokit, branchPrefix, 'feature-2', 5); // Short workflow (5s)
  
  // Create feature branch 2 - will have short-running tests
  await createFeatureBranch(apptokit, branchPrefix, '2');

  // Create and enqueue PR-2 (short-running tests)
  pull2 = await createPullRequest(apptokit, branchPrefix, '2');
  
  console.log('PR-2 created:', pull2.number);
  console.log('Enabling auto-merge for PR-2...');
  
  // Enable auto-merge (enqueue)
  await mergeWhenReady(apptokit, pull2.node_id);
  
  // Now both PRs are in the queue, with PR-2 having much faster tests
  // Wait for up to 60 seconds to let both PRs potentially merge
  let bothMerged = false;
  
  for (let i = 0; i < 12; i++) {
    console.log(`Checking merge status (attempt ${i + 1}/12)...`);
    
    // Check if PR-1 is merged
    const { data: pr1 } = await apptokit.rest.pulls.get({
      owner: '0x5b-org',
      repo: 'test-github-merge-queues',
      pull_number: pull1.number
    });
    
    // Check if PR-2 is merged
    const { data: pr2 } = await apptokit.rest.pulls.get({
      owner: '0x5b-org',
      repo: 'test-github-merge-queues',
      pull_number: pull2.number
    });
    
    if (pr1.merged && !mergeTimes[pull1.number]) {
      mergeTimes[pull1.number] = new Date();
      console.log(`PR-1 merged at ${mergeTimes[pull1.number].toISOString()}`);
    }
    
    if (pr2.merged && !mergeTimes[pull2.number]) {
      mergeTimes[pull2.number] = new Date();
      console.log(`PR-2 merged at ${mergeTimes[pull2.number].toISOString()}`);
    }
    
    if (pr1.merged && pr2.merged) {
      bothMerged = true;
      break;
    }
    
    await setTimeout(5000);
  }
  
  if (!bothMerged) {
    console.warn('Both PRs did not merge within the timeout period');
  }
}, 180_000);

describe('Non-ordered queueing', () => {
  it('should reveal whether GitHub merge queue is FIFO or readiness-ordered', async () => {
    // Verify both PRs were merged
    const { data: pr1 } = await apptokit.rest.pulls.get({
      owner: '0x5b-org',
      repo: 'test-github-merge-queues',
      pull_number: pull1.number
    });
    
    const { data: pr2 } = await apptokit.rest.pulls.get({
      owner: '0x5b-org',
      repo: 'test-github-merge-queues',
      pull_number: pull2.number
    });
    
    expect(pr1.merged).toBe(true);
    expect(pr2.merged).toBe(true);
    
    // Display merge times for analysis
    console.log('PR-1 merge time:', mergeTimes[pull1.number]?.toISOString() || 'Not merged');
    console.log('PR-2 merge time:', mergeTimes[pull2.number]?.toISOString() || 'Not merged');
    
    if (mergeTimes[pull1.number] && mergeTimes[pull2.number]) {
      // Determine if PRs were merged in FIFO order (PR-1 first) or readiness order (PR-2 first)
      const isReadinessOrder = mergeTimes[pull2.number] < mergeTimes[pull1.number];
      const isFifoOrder = mergeTimes[pull1.number] < mergeTimes[pull2.number];
      
      console.log('PRs merged in readiness order (faster PR first):', isReadinessOrder);
      console.log('PRs merged in FIFO order (PR-1 first):', isFifoOrder);
      
      // This test doesn't assert which ordering GitHub uses, as it's documenting behavior,
      // not enforcing a specific behavior. We just log the result.
    }
  });
});
