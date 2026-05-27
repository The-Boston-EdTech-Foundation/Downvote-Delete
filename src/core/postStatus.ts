import type { Post } from '@devvit/web/server';
import type { PostSnapshot } from './decision';

export function postToSnapshot(post: Post): PostSnapshot {
  return {
    score: post.score,
    approved: post.isApproved() || post.approved,
    removed: post.isRemoved() || post.removed,
    filtered: post.removedByCategory === 'automod_filtered',
    spam: post.isSpam() || post.spam,
    deleted: post.removedByCategory === 'deleted',
    // A failed fetch is handled by the scheduler as retryable; this flag is
    // reserved for a confirmed unavailable state if Devvit exposes one.
    unavailable: false,
  };
}
