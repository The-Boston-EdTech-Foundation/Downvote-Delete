# Downvote Delete

Downvote Delete is a Reddit Devvit moderation app that watches newly submitted posts and takes action when a post drops to a configured negative score.

Community members downvote rule-breaking content instead of reporting it, so use that signal to send it to mod queue!

## What It Does

Downvote Delete can:

- Watch new posts for 1, 2, or 3 hours.
- Detect when a post reaches negative scores (-3, -5, or -10).
- Stops watching posts that grow positively (+3, +5 or +10).
- Ignore manually approved posts.
- Stop tracking posts that are already removed, filtered, spammed, deleted, or unavailable.

Downvote Delete watches posts only. It does not track comments or scan older posts.

## Recommended Setup

For testing, start with:

- Action threshold: `-3` or `-5`
- Action to take: `Report to Mod Queue`
- Tracking window: `2 hours`

After reviewing results, switch to `Filter` or `Remove` if you want the app to act automatically.

## What the app does NOT do:

Downvote Delete will not:

- Track comments - use crowd control for this.
- Scan old posts from before installation.
- Action manually approved posts.
- Action the same tracked post more than once.
- Continue watching posts that were already moderated or deleted.

## Patch Notes

1.0.4 - Initial Public Release. Devvit 0.12.24