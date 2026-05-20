import type { Post, reddit } from '@devvit/web/server';
import {
  ACTION_FILTER,
  ACTION_REMOVE,
  ACTION_REPORT,
  type DownvoteDeleteAction,
} from './settings';

type RedditClient = typeof reddit;

export function buildActionReason(
  action: DownvoteDeleteAction,
  threshold: number
): string {
  if (action === ACTION_REPORT) {
    return `Reported for ${threshold} Downvote Karma`;
  }

  if (action === ACTION_FILTER) {
    return `Filtered for ${threshold} Downvote Karma`;
  }

  return `Removed for ${threshold} Downvote Karma`;
}

export async function applyModerationAction(args: {
  redditClient: RedditClient;
  post: Post;
  action: DownvoteDeleteAction;
  threshold: number;
}): Promise<void> {
  const reason = buildActionReason(args.action, args.threshold);

  if (args.action === ACTION_REPORT) {
    await args.redditClient.report(args.post, { reason });
    return;
  }

  if (args.action === ACTION_FILTER) {
    await args.post.filter(reason, false);
    return;
  }

  if (args.action === ACTION_REMOVE) {
    await args.post.remove(false);
    await args.post.addRemovalNote({ reasonId: '', modNote: reason });
  }
}
