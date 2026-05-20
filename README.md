# Downvote Delete

Downvote Delete is a Reddit Devvit moderation app that watches newly submitted posts and takes action when community voting drops a post to a configured negative score.

It is designed for moderators who want a simple safety net for posts that receive strong negative feedback soon after being submitted, without tracking comments or changing older content.

## Why Moderators Use It

- Reduce manual review of heavily downvoted new posts.
- Choose how strict the app should be for your community.
- Stop watching posts that recover or become positively received.
- Respect manual moderation decisions, including approvals and removals.
- Pause the app from settings without uninstalling it.

## How It Works

When a new post is submitted, Downvote Delete checks your app installation settings for that subreddit. If the app is active and the post is eligible, it starts watching the post for the selected tracking window.

The app checks the post's Reddit score on this schedule:

- 2 minutes after submission
- 5 minutes after the first check
- 10 minutes after the second check
- 20 minutes after the third check
- every 10 minutes after that until the tracking window ends

Downvote Delete watches newly submitted posts only. It does not scan older posts when installed, and it does not track comments.

The app stops watching a post when:

- the post reaches the positive stop threshold
- the selected tracking window expires
- a moderator manually approves the post
- the post is removed, filtered, marked spam, deleted, or unavailable
- Downvote Delete is turned off in settings

## Installation Settings

These settings are configured per subreddit from the app installation settings.

| Setting | Options | Default | What it does |
| --- | --- | --- | --- |
| Downvote Delete is active | On or off | On | Turns the app on or pauses it. When off, the app does not start watching new posts and does not action existing tracked posts. |
| Track posts for | 1 hour, 2 hours, 3 hours | 2 hours | Sets how long a new post can be watched before tracking expires. |
| Action post at score | -3, -5, -10 | -3 | Sets the negative score threshold. A watched post is actioned when its Reddit score is less than or equal to this value. |
| Stop watching at positive score | 3, 5, 10 | 5 | Stops tracking a post once it reaches this positive score. |
| Action to take | Report to Mod Queue, Filter, Remove | Remove | Chooses what happens when a watched post reaches the negative threshold. |
| Moderator post handling | Ignore downvoted moderator posts, Action all downvoted posts including moderators | Ignore downvoted moderator posts | Controls whether posts submitted by moderators can be watched and actioned. |

## Action Options

**Report to Mod Queue** sends the post to the moderation queue with a reason such as `Reported for -3 Downvote Karma`.

**Filter** removes the post from public view and sends it to Reddit's moderation review/removal surfaces with a reason such as `Filtered for -3 Downvote Karma`.

**Remove** performs a regular non-spam removal and adds a concise moderator note such as `Removed for -3 Downvote Karma`.

Downvote Delete does not leave a public comment or send a private message by default.

## Recommended Configurations

**Conservative communities**

Use a lower-sensitivity threshold such as `-10`, and start with `Report to Mod Queue` or `Filter` so moderators can review posts before final removal.

**High-volume communities**

Use `-3` or `-5` with `Remove` to reduce the amount of clearly rejected content that moderators need to handle manually.

**Trial mode**

Keep `Downvote Delete is active` turned on, set `Action to take` to `Report to Mod Queue`, and review what the app reports before switching to `Filter` or `Remove`.

**Pause mode**

Turn `Downvote Delete is active` off. The app will not start watching new posts and will not action existing tracked posts when checks run.

## Moderation Safety

Manually approved posts are exempt. If a watched post is later detected as approved, tracking stops and the post is not actioned.

Posts that are already removed, filtered, marked spam, deleted, or unavailable are no longer tracked. Downvote Delete avoids duplicate actions for the same tracked post.

Posts that reach the positive stop threshold are treated as accepted by the community and are no longer watched.

## What Downvote Delete Will Not Do

- It will not track comments.
- It will not scan older posts from before the app was installed.
- It will not calculate scores manually from upvotes and downvotes.
- It will not leave public comments by default.
- It will not send private messages by default.
- It will not use spam removal.
- It will not action the same tracked post more than once.

## For Maintainers

Common project commands:

```bash
npm run validate
npm run dev
npm run deploy
npm run launch
```

`npm run validate` runs linting, type checking, tests, and the production build.
