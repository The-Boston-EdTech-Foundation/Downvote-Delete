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
  actionStatus: 'succeeded' | 'failed';
  actionErrorMessage?: string;
  removalNoteStatus: 'not_applicable' | 'added' | 'failed';
  removalNoteErrorMessage?: string;
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

Please review the [community rules](https://reddit.com/r/${input.subredditName}/about/rules) before posting again.


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
    const result = await args.redditClient.report(args.post, { reason });
    const errors = result.json?.errors ?? [];
    if (errors.length > 0) {
      return {
        actionStatus: 'failed',
        actionErrorMessage: errors.join('; '),
        removalNoteStatus: 'not_applicable',
        modmailStatus: 'not_applicable',
      };
    }
    return {
      actionStatus: 'succeeded',
      removalNoteStatus: 'not_applicable',
      modmailStatus: 'not_applicable',
    };
  }

  if (args.action === ACTION_FILTER) {
    await args.post.filter({ reason, keep: false });
    return {
      actionStatus: 'succeeded',
      removalNoteStatus: 'not_applicable',
      modmailStatus: 'not_applicable',
    };
  }

  if (args.action === ACTION_REMOVE) {
    await args.post.remove(false);
    let removalNoteStatus: ModerationActionResult['removalNoteStatus'] =
      'added';
    let removalNoteErrorMessage: string | undefined;
    try {
      await args.post.addRemovalNote({ reasonId: '', modNote: reason });
    } catch (err: unknown) {
      removalNoteStatus = 'failed';
      removalNoteErrorMessage =
        err instanceof Error ? err.message : String(err);
    }

    const result: ModerationActionResult = {
      actionStatus: 'succeeded',
      removalNoteStatus,
      modmailStatus: 'not_applicable',
    };
    if (removalNoteErrorMessage) {
      result.removalNoteErrorMessage = removalNoteErrorMessage;
    }

    if (!args.authorName) {
      result.modmailStatus = 'skipped';
      result.modmailSkippedReason = 'missing_author_name';
      return result;
    }

    if (!args.subredditName) {
      result.modmailStatus = 'skipped';
      result.modmailSkippedReason = 'missing_subreddit_name';
      return result;
    }

    if (!args.postLink) {
      result.modmailStatus = 'skipped';
      result.modmailSkippedReason = 'missing_post_link';
      return result;
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

      result.modmailStatus = 'sent';
      result.modmailSentAt = Date.now();
      return result;
    } catch (err: unknown) {
      result.modmailStatus = 'failed';
      result.modmailErrorMessage =
        err instanceof Error ? err.message : String(err);
      result.modmailError = err;
      return result;
    }
  }

  return {
    actionStatus: 'failed',
    actionErrorMessage: 'Unsupported moderation action.',
    removalNoteStatus: 'not_applicable',
    modmailStatus: 'not_applicable',
  };
}
