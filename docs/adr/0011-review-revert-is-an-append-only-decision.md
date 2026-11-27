# Undo is a `revert` review, not a deletion

Undo appends a review with `decision='revert'`, which returns the value to pending and adds +1 to `pending_count`. It requires `expectedCurrentReviewId`, so a stale undo gets 409. History stays append-only, which DB privileges enforce. A reverted baseline never carries over. Without auth, "only your own action" is a UI convention backed by the optimistic-lock check, not a server guarantee.
