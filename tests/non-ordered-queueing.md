# Non-ordered Queueing

## Test

1. PR-1 gets enqueued (long tests running, e.g. 30s)
2. Midway through PR-1's tests, PR-2 gets enqueued (short tests, e.g. 5s)
3. PR-2's tests complete before PR-1's tests
4. Test whether:
   * PR-2 gets merged when its tests complete (queue is ordered by readiness)?
   * PR-2 waits for PR-1 to be merged first (queue is strictly FIFO)?

## Diagram

```mermaid
%%{init: {'theme':'default'}}%%

gitGraph
    commit

    branch feature-1
    checkout feature-1
    commit
    commit id: "enqueue 1" tag: "MQ build 1 (30s)"

    checkout main
    branch feature-2
    checkout feature-2
    commit
    commit id: "enqueue 2" tag: "MQ build 2 (5s)"

    checkout main
    
    % If queue is ordered by readiness
    merge feature-2
    merge feature-1
    commit tag: "readiness ordering"

    % If queue is FIFO
    % merge feature-1
    % merge feature-2
    % commit tag: "FIFO ordering"
```
