import type { Post, reddit } from '@devvit/web/server';
import {
  ACTION_FILTER,
  ACTION_REPORT,
  type DownvoteDeleteAction,
} from './settings';

type RedditClient = typeof reddit;

export const REMOVAL_PRIVATE_MESSAGE_SUBJECT = 'Your post has been removed';

export type RemovalPrivateMessageInput = {
  username: string;
  subredditName: string;
  postLink: string;
  explanation?: string;
};

export type RemovalCommentInput = {
  subredditName: string;
  explanation?: string;
};

export type ModerationActionResult = {
  actionStatus: 'succeeded' | 'failed';
  actionErrorMessage?: string;
  postLockStatus: 'not_applicable' | 'locked' | 'failed';
  postLockErrorMessage?: string;
  postUnlockStatus?: 'not_applicable' | 'unlocked' | 'failed';
  postUnlockErrorMessage?: string;
  removalNoteStatus: 'not_applicable' | 'added' | 'failed';
  removalNoteErrorMessage?: string;
  privateMessageStatus: 'not_applicable' | 'sent' | 'skipped' | 'failed';
  privateMessageSentAt?: number;
  privateMessageSkippedReason?: string;
  privateMessageErrorMessage?: string;
  privateMessageError?: unknown;
  removalCommentStatus: 'not_applicable' | 'added' | 'skipped' | 'failed';
  removalCommentAddedAt?: number;
  removalCommentId?: string;
  removalCommentSkippedReason?: string;
  removalCommentErrorMessage?: string;
  removalCommentError?: unknown;
  removalCommentStyleStatus: 'not_applicable' | 'styled' | 'failed';
  removalCommentStyleErrorMessage?: string;
  removalCommentStyleError?: unknown;
};

export type ModerationActionArgs = {
  redditClient: RedditClient;
  post: Post;
  action: Exclude<DownvoteDeleteAction, 'remove'>;
  threshold: number;
  reason?: string;
  removalExplanation?: string;
  sendRemovalDirectMessage?: boolean;
  leaveRemovalComment?: boolean;
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

export function buildRemovedForDownvotesPrivateMessageBody(
  input: RemovalPrivateMessageInput
): string {
  return `Hi u/${input.username},

${input.explanation ?? 'Your post was removed because it received too much negative community feedback.'}

Posts may be downvoted for many reasons, including rule issues, content quality, or controversial opinions. This removal helps prevent your account from accumulating additional negative karma from the post.

Please review the [community rules](https://reddit.com/r/${input.subredditName}/about/rules) before posting again.


*Removed post: ${input.postLink}*`;
}

export function buildRemovedForDownvotesCommentBody(
  input: RemovalCommentInput
): string {
  return `${input.explanation ?? 'Your post was removed because it received too much negative community feedback.'}

Posts may be downvoted for many reasons, including rule issues, content quality, or controversial opinions. This removal helps prevent your account from accumulating additional negative karma from the post.

Please review the [community rules](https://reddit.com/r/${input.subredditName}/about/rules) before posting again.`;
}

export async function sendRemovalPrivateMessage(args: {
  redditClient: RedditClient;
  username: string;
  subredditName: string;
  postLink: string;
  explanation?: string;
}): Promise<void> {
  const bodyInput: RemovalPrivateMessageInput = {
    username: args.username,
    subredditName: args.subredditName,
    postLink: args.postLink,
  };

  if (args.explanation) {
    bodyInput.explanation = args.explanation;
  }

  await args.redditClient.sendPrivateMessage({
    to: args.username,
    subject: REMOVAL_PRIVATE_MESSAGE_SUBJECT,
    text: buildRemovedForDownvotesPrivateMessageBody(bodyInput),
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
        postLockStatus: 'not_applicable',
        removalNoteStatus: 'not_applicable',
        privateMessageStatus: 'not_applicable',
        removalCommentStatus: 'not_applicable',
        removalCommentStyleStatus: 'not_applicable',
      };
    }
    return {
      actionStatus: 'succeeded',
      postLockStatus: 'not_applicable',
      removalNoteStatus: 'not_applicable',
      privateMessageStatus: 'not_applicable',
      removalCommentStatus: 'not_applicable',
      removalCommentStyleStatus: 'not_applicable',
    };
  }

  if (args.action === ACTION_FILTER) {
    await args.post.filter({ reason, keep: false });
    return {
      actionStatus: 'succeeded',
      postLockStatus: 'not_applicable',
      removalNoteStatus: 'not_applicable',
      privateMessageStatus: 'not_applicable',
      removalCommentStatus: 'not_applicable',
      removalCommentStyleStatus: 'not_applicable',
    };
  }

  return {
    actionStatus: 'failed',
    actionErrorMessage: 'Unsupported moderation action.',
    postLockStatus: 'not_applicable',
    removalNoteStatus: 'not_applicable',
    privateMessageStatus: 'not_applicable',
    removalCommentStatus: 'not_applicable',
    removalCommentStyleStatus: 'not_applicable',
  };
}
