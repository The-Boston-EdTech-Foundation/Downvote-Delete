# Downvote Delete

Downvote Delete is a Reddit Devvit moderation app that watches newly submitted posts and takes action when a post drops to a configured negative score.

It is built for communities that want a simple safety net for posts receiving strong negative feedback soon after submission.

## What It Does

Downvote Delete can:

- Watch new posts for 1, 2, or 3 hours.
- Take action at -3, -5, or -10 score.
- Stop watching posts that recover to a positive score.
- Ignore manually approved posts.
- Stop tracking posts that are already removed, filtered, spammed, deleted, or unavailable.
- Be paused from app settings without uninstalling.

Downvote Delete watches posts only. It does not track comments or scan older posts.

## Recommended Setup

For testing, start with:

- Action threshold: `-3` or `-5`
- Action to take: `Report to Mod Queue`
- Tracking window: `2 hours`

After reviewing results, switch to `Filter` or `Remove` if you want the app to act automatically.

For stricter communities, use `-3`.

For more cautious communities, use `-10`.

## Safety Rules

Downvote Delete will not:

- Track comments.
- Scan old posts from before installation.
- Action manually approved posts.
- Use spam removal.
- Action the same tracked post more than once.
- Continue watching posts that were already moderated or deleted.

Turn off **Downvote Delete is active** in settings to pause the app.