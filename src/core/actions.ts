import type { Post, reddit } from '@devvit/web/server';
import {
  ACTION_FILTER,
  ACTION_REMOVE,
  ACTION_REPORT,
  type DownvoteDeleteAction,
} from './settings';

type RedditClient = typeof reddit;

export const REMOVAL_MODMAIL_SUBJECT = 'Your post has been removed';

export type RemovalModmailInput = {
  username: string;
  subredditName: string;
  postLink: string;
  explanation?: string;
};

export type ModerationActionResult = {
  modmailStatus: 'not_applicable' | 'sent' | 'skipped' | 'failed';
  modmailSentAt?: number;
  modmailSkippedReason?: string;
  modmailErrorMessage?: string;
  modmailError?: unknown;
};

export type ModerationActionArgs = {
  redditClient: RedditClient;
  post: Post;
  action: DownvoteDeleteAction;
  threshold: number;
  reason?: string;
  removalExplanation?: string;
  authorName?: string;
  subredditName?: string;
  postLink?: string;
};

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

export function buildRemovedForDownvotesModmailBody(
  input: RemovalModmailInput
): string {
  return `Hi u/${input.username},

${input.explanation ?? 'Your post was removed because it received too much negative community feedback.'}

Posts may be downvoted for many reasons, including rule issues, content quality, or controversial opinions. This removal helps prevent your account from accumulating additional negative karma from the post.

Please review the [community rules](https://www.reddit.com/r/${input.subredditName}/about/rules) before posting again.


*Removed post: ${input.postLink}*`;
}

export async function sendRemovalModmail(args: {
  redditClient: RedditClient;
  username: string;
  subredditName: string;
  postLink: string;
  explanation?: string;
}): Promise<void> {
  const bodyInput: RemovalModmailInput = {
    username: args.username,
    subredditName: args.subredditName,
    postLink: args.postLink,
  };

  if (args.explanation) {
    bodyInput.explanation = args.explanation;
  }

  await args.redditClient.modMail.createConversation({
    subredditName: args.subredditName,
    subject: REMOVAL_MODMAIL_SUBJECT,
    body: buildRemovedForDownvotesModmailBody(bodyInput),
    to: `u/${args.username}`,
    isAuthorHidden: true,
  });
}

export async function applyModerationAction(
  args: ModerationActionArgs
): Promise<ModerationActionResult> {
  const reason = args.reason ?? buildActionReason(args.action, args.threshold);

  if (args.action === ACTION_REPORT) {
    await args.redditClient.report(args.post, { reason });
    return { modmailStatus: 'not_applicable' };
  }

  if (args.action === ACTION_FILTER) {
    await args.post.filter(reason, false);
    return { modmailStatus: 'not_applicable' };
  }

  if (args.action === ACTION_REMOVE) {
    await args.post.remove(false);
    await args.post.addRemovalNote({ reasonId: '', modNote: reason });

    if (!args.authorName) {
      return {
        modmailStatus: 'skipped',
        modmailSkippedReason: 'missing_author_name',
      };
    }

    if (!args.subredditName) {
      return {
        modmailStatus: 'skipped',
        modmailSkippedReason: 'missing_subreddit_name',
      };
    }

    if (!args.postLink) {
      return {
        modmailStatus: 'skipped',
        modmailSkippedReason: 'missing_post_link',
      };
    }

    try {
      const modmailArgs: Parameters<typeof sendRemovalModmail>[0] = {
        redditClient: args.redditClient,
        username: args.authorName,
        subredditName: args.subredditName,
        postLink: args.postLink,
      };

      if (args.removalExplanation) {
        modmailArgs.explanation = args.removalExplanation;
      }

      await sendRemovalModmail(modmailArgs);

      return {
        modmailStatus: 'sent',
        modmailSentAt: Date.now(),
      };
    } catch (err: unknown) {
      return {
        modmailStatus: 'failed',
        modmailErrorMessage: err instanceof Error ? err.message : String(err),
        modmailError: err,
      };
    }
  }

  return { modmailStatus: 'not_applicable' };
}
