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
  queue 
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

const branchPrefix = 'mid-queue-conflicts';

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
let pr2KickedBackImmediately = false;
let pr2KickedBackAfterPr1Merged = false;
let pr2MergedWithConflictResolution = false;

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
  
  _mainSha = await createMainBranch(apptokit, branchPrefix, 15); // 15s workflow

  // Create feature branch 1
  await createFeatureBranch(apptokit, branchPrefix, '1');
  
  // Create a file in feature branch 1 that will conflict with feature branch 2
  const { data: file1 } = await apptokit.rest.repos.createOrUpdateFileContents({
    owner: '0x5b-org',
    repo: 'test-github-merge-queues',
    path: 'conflict-file.txt',
    message: 'Add conflict file in feature-1',
    content: Buffer.from('Content from feature-1').toString('base64'),
    branch: `${branchPrefix}/feature-1`
  });
  
  console.log('Conflict file added to feature-1:', file1.commit.sha);

  // Create and enqueue PR-1
  pull1 = await createPullRequest(apptokit, branchPrefix, '1');
  
  console.log('PR-1 created:', pull1.number);
  console.log('Enabling auto-merge for PR-1...');
  
  // Enable auto-merge (enqueue) for PR-1
  await mergeWhenReady(apptokit, pull1.node_id);
  
  // Wait for PR-1 to start processing (5 seconds should be sufficient)
  await setTimeout(5000);
  
  // Create feature branch 2
  await createFeatureBranch(apptokit, branchPrefix, '2');
  
  // Create the same file in feature branch 2 with different content to cause a conflict
  const { data: file2 } = await apptokit.rest.repos.createOrUpdateFileContents({
    owner: '0x5b-org',
    repo: 'test-github-merge-queues',
    path: 'conflict-file.txt',
    message: 'Add conflict file in feature-2',
    content: Buffer.from('Content from feature-2').toString('base64'),
    branch: `${branchPrefix}/feature-2`
  });
  
  console.log('Conflict file added to feature-2:', file2.commit.sha);

  // Create PR-2, which will conflict with PR-1
  pull2 = await createPullRequest(apptokit, branchPrefix, '2');
  
  console.log('PR-2 created:', pull2.number);
  console.log('Enabling auto-merge for PR-2...');
  
  try {
    // Try to enable auto-merge for PR-2
    await mergeWhenReady(apptokit, pull2.node_id);
    
    // If we get here, PR-2 was added to the queue despite conflicts
    console.log('PR-2 was added to the merge queue');
    
    // Check queue status after 5 seconds
    await setTimeout(5000);
    
    const queueEntries = await queue(apptokit, `${branchPrefix}/main`);
    const pr2InQueue = queueEntries.some(e => e.pullRequest.number === pull2.number);
    
    if (!pr2InQueue) {
      pr2KickedBackImmediately = true;
      console.log('PR-2 was kicked back from the queue immediately after adding');
    }
  } catch (error: any) {
    // If we get an error while trying to add PR-2 to the queue, it was rejected immediately
    console.log('Error while adding PR-2 to merge queue:', error.message);
    pr2KickedBackImmediately = true;
  }
  
  // Wait to see if PR-1 merges (up to 30 seconds)
  let pr1Merged = false;
  
  for (let i = 0; i < 6; i++) {
    console.log(`Checking if PR-1 has merged (attempt ${i + 1}/6)...`);
    
    const { data: pr1Status } = await apptokit.rest.pulls.get({
      owner: '0x5b-org',
      repo: 'test-github-merge-queues',
      pull_number: pull1.number
    });
    
    if (pr1Status.merged) {
      pr1Merged = true;
      console.log('PR-1 has been merged');
      break;
    }
    
    await setTimeout(5000);
  }
  
  if (!pr1Merged) {
    console.warn('PR-1 did not merge within the timeout period');
    return;
  }
  
  // After PR-1 merges, if PR-2 was in the queue, check if it gets kicked back
  if (!pr2KickedBackImmediately) {
    await setTimeout(5000);
    
    const { data: pr2Status } = await apptokit.rest.pulls.get({
      owner: '0x5b-org',
      repo: 'test-github-merge-queues',
      pull_number: pull2.number
    });
    
    const queueEntries = await queue(apptokit, `${branchPrefix}/main`);
    const pr2StillInQueue = queueEntries.some(e => e.pullRequest.number === pull2.number);
    
    if (!pr2StillInQueue && !pr2Status.merged) {
      pr2KickedBackAfterPr1Merged = true;
      console.log('PR-2 was kicked back after PR-1 merged');
    }
    
    // If PR-2 is still in queue, try resolving the conflicts and see if it merges
    if (pr2StillInQueue) {
      console.log('PR-2 is still in queue after PR-1 merged. Attempting to resolve conflicts...');
      
      // Sync PR-2 branch with the main branch to resolve conflicts
      const { data: _mainBranch } = await apptokit.rest.repos.getBranch({
        owner: '0x5b-org',
        repo: 'test-github-merge-queues',
        branch: `${branchPrefix}/main`
      });
      
      // Create a merge commit to resolve conflicts
      try {
        await apptokit.rest.repos.merge({
          owner: '0x5b-org',
          repo: 'test-github-merge-queues',
          base: `${branchPrefix}/feature-2`,
          head: `${branchPrefix}/main`,
          commit_message: 'Merge main into feature-2 to resolve conflicts'
        });
        
        console.log('Conflicts resolved by merging main into feature-2');
        
        // Update the conflict file with resolved content
        await apptokit.rest.repos.createOrUpdateFileContents({
          owner: '0x5b-org',
          repo: 'test-github-merge-queues',
          path: 'conflict-file.txt',
          message: 'Resolve conflicts in feature-2',
          content: Buffer.from('Resolved content from both feature-1 and feature-2').toString('base64'),
          branch: `${branchPrefix}/feature-2`,
          sha: file2.content?.sha // Provide SHA to update existing file (with null check)
        });
        
        console.log('Conflict file updated with resolved content');
        
        // Wait to see if PR-2 merges after conflict resolution (up to 30 seconds)
        for (let i = 0; i < 6; i++) {
          console.log(`Checking if PR-2 has merged after conflict resolution (attempt ${i + 1}/6)...`);
          
          const { data: pr2Status } = await apptokit.rest.pulls.get({
            owner: '0x5b-org',
            repo: 'test-github-merge-queues',
            pull_number: pull2.number
          });
          
          if (pr2Status.merged) {
            pr2MergedWithConflictResolution = true;
            console.log('PR-2 has been merged after conflict resolution');
            break;
          }
          
          await setTimeout(5000);
        }
      } catch (error: any) {
        console.error('Error while resolving conflicts:', error.message);
      }
    }
  }
}, 180_000);

describe('Mid-queue merge conflicts', () => {
  it('should reveal how GitHub merge queue handles conflicting PRs', async () => {
    // Verify PR-1 was merged
    const { data: pr1 } = await apptokit.rest.pulls.get({
      owner: '0x5b-org',
      repo: 'test-github-merge-queues',
      pull_number: pull1.number
    });
    
    expect(pr1.merged).toBe(true);
    
    // Document the observed behavior
    console.log('PR-2 kicked back immediately upon enqueuing:', pr2KickedBackImmediately);
    console.log('PR-2 kicked back after PR-1 merged:', pr2KickedBackAfterPr1Merged);
    console.log('PR-2 merged after conflict resolution:', pr2MergedWithConflictResolution);
    
    // Check the current state of PR-2
    const { data: pr2 } = await apptokit.rest.pulls.get({
      owner: '0x5b-org',
      repo: 'test-github-merge-queues',
      pull_number: pull2.number
    });
    
    console.log('PR-2 final state - merged:', pr2.merged);
    console.log('PR-2 final state - mergeable_state:', pr2.mergeable_state);
    console.log('PR-2 final state - mergeable:', pr2.mergeable);
    
    // This test doesn't assert specific behavior as it's documenting how GitHub handles this scenario
  });
});
