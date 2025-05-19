# Mid-queue Merge Conflicts

## Test

1. PR-1 gets enqueued (tests running, long enough to enqueue PR-2 while it's in the queue)
2. PR-2 gets enqueued (conflicts with PR-1)
3. Test whether:
   * PR-2 gets kicked back immediately upon enqueuing (with a reason indicating the conflict)?
   * PR-2 gets kicked back after PR-1 merges?
   * PR-2 remains in the queue but cannot be merged until the conflicts are resolved?

## Diagram

```mermaid
%%{init: {'theme':'default'}}%%

gitGraph
    commit

    branch feature-1
    checkout feature-1
    commit
    commit id: "file-a.txt" tag: "Modify file-a.txt"
    commit id: "enqueue 1" tag: "merge-queue build 1"

    checkout main
    branch feature-2
    checkout feature-2
    commit
    commit id: "file-a-conflict.txt" tag: "Modify same file-a.txt"
    commit id: "enqueue 2" tag: "merge-queue build 2"

    checkout main
    
    %% If PR-2 is kicked back immediately
    merge feature-1
    commit tag: "only PR-1 merges"

    %% If PR-2 is kicked back after PR-1 merges
    merge feature-1
    commit tag: "PR-2 gets kicked back after PR-1 merges"

    %% If PR-2 remains in queue but needs resolution
    merge feature-1
    checkout feature-2
    commit id: "resolve" tag: "Resolve conflicts"
    checkout main
    merge feature-2
    commit tag: "PR-2 merges after conflict resolution"
```
