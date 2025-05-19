# Mutated Main

## Test

1. PR-1 gets enqueued (tests running)
2. Main gets mutated (release from prior release)
* If no merge conflict, then PR-1 just gets merged (not necessarily safe)
* If merge conflict, PR-1 gets kicked back

## Diagram

```mermaid
%%{init: {'theme':'default'}}%%

gitGraph
    commit

    branch feature-1
    checkout feature-1
    commit
    commit id: "enqueue 1" tag: "merge-queue build 1"

    checkout main
    commit tag: "release 0"

    checkout main
    merge feature-1
    commit tag: "release 1"
```