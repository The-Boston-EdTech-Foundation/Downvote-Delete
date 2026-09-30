import type { Post, reddit } from '@devvit/web/server';
import type { T1 } from '@devvit/shared-types/tid.js';
import {
  buildRemovedForDownvotesCommentBody,
  sendRemovalPrivateMessage,
} from './actions';
import type { TrackedPost } from './tracking';

type RedditClient = typeof reddit;

export type PersistRemovalRecord = (record: TrackedPost) => Promise<void>;

export type RemovalWorkflowResult = {
  record: TrackedPost;
  actionStatus: 'succeeded' | 'failed';
  actionErrorMessage?: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function persistStage(
  record: TrackedPost,
  persist: PersistRemovalRecord,
  now: () => number
): Promise<TrackedPost> {
  const updated = { ...record, updatedAt: now() };
  await persist(updated);
  return updated;
}

async function compensateUnlock(args: {
  post: Post;
  record: TrackedPost;
  persist: PersistRemovalRecord;
  now: () => number;
}): Promise<TrackedPost> {
  if (args.record.postLockStatus !== 'locked') {
    return args.record;
  }

  let record: TrackedPost = {
    ...args.record,
    postUnlockAttemptedAt: args.now(),
  };
  try {
    await args.post.unlock();
    record = { ...record, postUnlockStatus: 'unlocked' };
  } catch (error: unknown) {
    record = {
      ...record,
      postUnlockStatus: 'failed',
      postUnlockErrorMessage: errorMessage(error),
    };
  }
  return persistStage(record, args.persist, args.now);
}

async function applyRemovalNote(args: {
  post: Post;
  record: TrackedPost;
  persist: PersistRemovalRecord;
  now: () => number;
}): Promise<TrackedPost> {
  if (
    args.record.removalNoteStatus === 'added' ||
    args.record.removalNoteStatus === 'failed' ||
    args.record.removalNoteStatus === 'delivery_unknown'
  ) {
    return args.record;
  }
  if (args.record.removalNoteStatus === 'attempting') {
    return persistStage(
      {
        ...args.record,
        removalNoteStatus: 'delivery_unknown',
        removalNoteErrorMessage:
          'Recovery could not determine whether the removal note was added.',
      },
      args.persist,
      args.now
    );
  }

  let record = await persistStage(
    { ...args.record, removalNoteStatus: 'attempting' },
    args.persist,
    args.now
  );
  try {
    await args.post.addRemovalNote({
      reasonId: '',
      modNote:
        record.actionReason ??
        `Removed for ${record.negativeScoreThreshold} Downvote Karma`,
    });
    record = { ...record, removalNoteStatus: 'added' };
  } catch (error: unknown) {
    record = {
      ...record,
      removalNoteStatus: 'failed',
      removalNoteErrorMessage: errorMessage(error),
    };
  }
  return persistStage(record, args.persist, args.now);
}

async function findExistingRemovalComment(args: {
  post: Post;
  redditClient: RedditClient;
  body: string;
}): Promise<Awaited<ReturnType<Post['comments']['all']>>[number] | undefined> {
  const appUsername = await args.redditClient.getCurrentUsername();
  if (!appUsername) {
    throw new Error('App username unavailable during comment reconciliation.');
  }
  const comments = await args.post.comments.get(100);
  return comments.find(
    (comment) =>
      comment.authorName.toLocaleLowerCase() ===
        appUsername.toLocaleLowerCase() &&
      comment.body.trim() === args.body.trim()
  );
}

async function styleRemovalComment(args: {
  redditClient: RedditClient;
  commentId: string;
  record: TrackedPost;
  persist: PersistRemovalRecord;
  now: () => number;
}): Promise<TrackedPost> {
  if (args.record.removalCommentStyleStatus === 'styled') {
    return args.record;
  }
  let record = args.record;
  try {
    const comment = await args.redditClient.getCommentById(
      args.commentId as T1
    );
    await comment.distinguish(true);
    record = { ...record, removalCommentStyleStatus: 'styled' };
  } catch (error: unknown) {
    record = {
      ...record,
      removalCommentStyleStatus: 'failed',
      removalCommentStyleErrorMessage: errorMessage(error),
    };
  }
  return persistStage(record, args.persist, args.now);
}

async function deliverRemovalComment(args: {
  post: Post;
  redditClient: RedditClient;
  record: TrackedPost;
  persist: PersistRemovalRecord;
  now: () => number;
}): Promise<TrackedPost> {
  if (!args.record.leaveRemovalComment) {
    if (args.record.removalCommentStatus === 'skipped') {
      return args.record;
    }
    return persistStage(
      {
        ...args.record,
        removalCommentStatus: 'skipped',
        removalCommentSkippedReason: 'disabled_by_settings',
        removalCommentStyleStatus: 'not_applicable',
      },
      args.persist,
      args.now
    );
  }

  const body = buildRemovedForDownvotesCommentBody({
    subredditName: args.record.subredditName,
  });
  let record = args.record;

  if (
    record.removalCommentStatus === 'added' ||
    record.removalCommentStatus === 'reconciled'
  ) {
    return record.removalCommentId
      ? styleRemovalComment({
          redditClient: args.redditClient,
          commentId: record.removalCommentId,
          record,
          persist: args.persist,
          now: args.now,
        })
      : record;
  }
  if (record.removalCommentStatus === 'failed') {
    return record;
  }

  if (record.removalCommentStatus === 'attempting') {
    // If Reddit cannot be queried this throws, keeping the recovery pending.
    const existing = await findExistingRemovalComment({
      post: args.post,
      redditClient: args.redditClient,
      body,
    });
    if (existing) {
      record = await persistStage(
        {
          ...record,
          removalCommentStatus: 'reconciled',
          removalCommentId: String(existing.id),
          removalCommentAddedAt: existing.createdAt.getTime(),
        },
        args.persist,
        args.now
      );
      return styleRemovalComment({
        redditClient: args.redditClient,
        commentId: String(existing.id),
        record,
        persist: args.persist,
        now: args.now,
      });
    }
  }

  record = await persistStage(
    {
      ...record,
      removalCommentStatus: 'attempting',
      removalCommentAttemptedAt: args.now(),
      removalCommentStyleStatus: 'not_applicable',
    },
    args.persist,
    args.now
  );
  let comment: Awaited<ReturnType<Post['addComment']>>;
  try {
    comment = await args.post.addComment({ text: body, runAs: 'APP' });
  } catch (error: unknown) {
    return persistStage(
      {
        ...record,
        removalCommentStatus: 'failed',
        removalCommentErrorMessage: errorMessage(error),
      },
      args.persist,
      args.now
    );
  }
  // If this persistence fails, recovery sees "attempting" and reconciles the
  // app-authored comment instead of blindly posting a duplicate.
  record = await persistStage(
    {
      ...record,
      removalCommentStatus: 'added',
      removalCommentId: String(comment.id),
      removalCommentAddedAt: args.now(),
    },
    args.persist,
    args.now
  );
  try {
    await comment.distinguish(true);
    record = { ...record, removalCommentStyleStatus: 'styled' };
  } catch (error: unknown) {
    record = {
      ...record,
      removalCommentStyleStatus: 'failed',
      removalCommentStyleErrorMessage: errorMessage(error),
    };
  }
  return persistStage(record, args.persist, args.now);
}

async function deliverRemovalPrivateMessage(args: {
  redditClient: RedditClient;
  postLink: string;
  record: TrackedPost;
  persist: PersistRemovalRecord;
  now: () => number;
}): Promise<TrackedPost> {
  let record = args.record;
  if (!record.sendRemovalDirectMessage) {
    return record.privateMessageStatus === 'skipped'
      ? record
      : persistStage(
          {
            ...record,
            privateMessageStatus: 'skipped',
            privateMessageSkippedReason: 'disabled_by_settings',
          },
          args.persist,
          args.now
        );
  }
  if (!record.authorName) {
    return persistStage(
      {
        ...record,
        privateMessageStatus: 'skipped',
        privateMessageSkippedReason: 'missing_author_name',
      },
      args.persist,
      args.now
    );
  }
  const authorName = record.authorName;
  if (
    record.privateMessageStatus === 'sent' ||
    record.privateMessageStatus === 'skipped' ||
    record.privateMessageStatus === 'failed' ||
    record.privateMessageStatus === 'delivery_unknown'
  ) {
    return record;
  }
  if (record.privateMessageStatus === 'attempting') {
    return persistStage(
      {
        ...record,
        privateMessageStatus: 'delivery_unknown',
        privateMessageErrorMessage:
          'Recovery could not determine whether the direct message was delivered.',
      },
      args.persist,
      args.now
    );
  }

  record = await persistStage(
    {
      ...record,
      privateMessageStatus: 'attempting',
      privateMessageAttemptedAt: args.now(),
    },
    args.persist,
    args.now
  );
  try {
    await sendRemovalPrivateMessage({
      redditClient: args.redditClient,
      username: authorName,
      subredditName: record.subredditName,
      postLink: args.postLink,
    });
    record = {
      ...record,
      privateMessageStatus: 'sent',
      privateMessageSentAt: args.now(),
    };
  } catch (error: unknown) {
    record = {
      ...record,
      privateMessageStatus: 'failed',
      privateMessageErrorMessage: errorMessage(error),
    };
  }
  return persistStage(record, args.persist, args.now);
}

export async function deliverPendingRemovalNotifications(args: {
  post: Post;
  redditClient: RedditClient;
  postLink: string;
  record: TrackedPost;
  persist: PersistRemovalRecord;
  now?: () => number;
}): Promise<TrackedPost> {
  const now = args.now ?? Date.now;
  let record = await persistStage(
    { ...args.record, actionPhase: 'notifications_pending' },
    args.persist,
    now
  );
  record = await deliverRemovalComment({ ...args, record, now });
  record = await deliverRemovalPrivateMessage({ ...args, record, now });
  return persistStage(
    {
      ...record,
      actionPhase: 'notifications_complete',
      notificationCompletedAt: now(),
    },
    args.persist,
    now
  );
}

export async function executeRemovalWorkflow(args: {
  post: Post;
  redditClient: RedditClient;
  postLink: string;
  record: TrackedPost;
  persist: PersistRemovalRecord;
  now?: () => number;
}): Promise<RemovalWorkflowResult> {
  const now = args.now ?? Date.now;
  let record: TrackedPost = {
    ...args.record,
    actionPhase: 'action_pending',
    removalNoteStatus: 'pending',
    privateMessageStatus: args.record.sendRemovalDirectMessage
      ? 'pending'
      : 'skipped',
    removalCommentStatus: args.record.leaveRemovalComment
      ? 'pending'
      : 'skipped',
    removalCommentStyleStatus: 'not_applicable',
  };
  if (!record.sendRemovalDirectMessage) {
    record.privateMessageSkippedReason = 'disabled_by_settings';
  }
  if (!record.leaveRemovalComment) {
    record.removalCommentSkippedReason = 'disabled_by_settings';
  }
  record = await persistStage(record, args.persist, now);

  try {
    await args.post.lock();
    record = { ...record, postLockStatus: 'locked' };
  } catch (error: unknown) {
    record = {
      ...record,
      postLockStatus: 'failed',
      postLockErrorMessage: errorMessage(error),
    };
  }
  record = await persistStage(
    { ...record, actionPhase: 'lock_attempted' },
    args.persist,
    now
  );
  record = await persistStage(
    { ...record, actionPhase: 'removal_attempted' },
    args.persist,
    now
  );

  try {
    await args.post.remove(false);
  } catch (error: unknown) {
    record = await compensateUnlock({
      post: args.post,
      record: {
        ...record,
        actionOutcome: 'failed',
        actionErrorMessage: errorMessage(error),
        removalNoteStatus: 'not_applicable',
        removalCommentStatus: 'not_applicable',
        removalCommentStyleStatus: 'not_applicable',
        privateMessageStatus: 'not_applicable',
      },
      persist: args.persist,
      now,
    });
    return {
      record,
      actionStatus: 'failed',
      actionErrorMessage: errorMessage(error),
    };
  }

  record = await persistStage(
    {
      ...record,
      actionOutcome: 'succeeded',
      actionPhase: 'removal_confirmed',
      removalConfirmedAt: now(),
    },
    args.persist,
    now
  );
  record = await applyRemovalNote({
    post: args.post,
    record,
    persist: args.persist,
    now,
  });
  record = await deliverPendingRemovalNotifications({ ...args, record, now });
  return { record, actionStatus: 'succeeded' };
}

export async function recoverConfirmedRemoval(args: {
  post: Post;
  redditClient: RedditClient;
  postLink: string;
  record: TrackedPost;
  persist: PersistRemovalRecord;
  now?: () => number;
}): Promise<TrackedPost> {
  const now = args.now ?? Date.now;
  let record = await persistStage(
    {
      ...args.record,
      actionOutcome: 'succeeded',
      actionPhase: 'removal_confirmed',
      removalConfirmedAt: args.record.removalConfirmedAt ?? now(),
      recoveryAttemptedAt: now(),
      recoveryReason: 'confirmed_removed',
    },
    args.persist,
    now
  );
  record = await applyRemovalNote({
    post: args.post,
    record,
    persist: args.persist,
    now,
  });
  return deliverPendingRemovalNotifications({ ...args, record, now });
}

export async function compensateUnremovedPost(args: {
  post: Post;
  record: TrackedPost;
  persist: PersistRemovalRecord;
  now?: () => number;
}): Promise<TrackedPost> {
  return compensateUnlock({ ...args, now: args.now ?? Date.now });
}
