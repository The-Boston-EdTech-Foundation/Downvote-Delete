import { Devvit } from '@devvit/public-api';
import type { SettingsFormField } from '@devvit/public-api';
import { CHECK_WATCHED_POST_TASK } from './core/constants';
import {
  ACTION_FILTER,
  ACTION_REMOVE,
  ACTION_REPORT,
  MODERATOR_ACTION_ALL,
  MODERATOR_IGNORE,
} from './core/settings';
import {
  handlePostSubmitTrigger,
  handlePostUpdateTrigger,
  type TriggerClients,
} from './core/triggerHandlers';
import {
  handleScheduledPostCheck,
  type ScheduledCheckClients,
} from './routes/scheduler';

Devvit.configure({
  redditAPI: true,
  redis: true,
});

Devvit.addSettings([
  {
    type: 'boolean',
    name: 'isActive',
    label: 'Downvote Delete is active',
    helpText:
      'Disable this to temporarily pause downvote delete from actioning content.',
    defaultValue: true,
  },
  {
    type: 'select',
    name: 'trackingDurationHours',
    label: 'Track posts for',
    options: [
      { label: '2 hours', value: '2' },
      { label: '4 hours', value: '4' },
      { label: '6 hours', value: '6' },
    ],
    defaultValue: ['4'],
  },
  {
    type: 'select',
    name: 'negativeScoreThreshold',
    label: 'Action post at score',
    options: [
      { label: '-1', value: '-1' },
      { label: '-2', value: '-2' },
      { label: '-3', value: '-3' },
      { label: '-4', value: '-4' },
      { label: '-5', value: '-5' },
    ],
    defaultValue: ['-3'],
  },
  {
    type: 'select',
    name: 'positiveScoreStopThreshold',
    label: 'Stop watching at positive score',
    options: [
      { label: '3', value: '3' },
      { label: '5', value: '5' },
      { label: '10', value: '10' },
    ],
    defaultValue: ['5'],
  },
  {
    type: 'select',
    name: 'actionToTake',
    label: 'Action to take',
    options: [
      { label: 'Report to Mod Queue', value: ACTION_REPORT },
      { label: 'Filter', value: ACTION_FILTER },
      { label: 'Remove', value: ACTION_REMOVE },
    ],
    defaultValue: [ACTION_REMOVE],
  },
  {
    type: 'select',
    name: 'moderatorPostHandling',
    label: 'Moderator post handling',
    options: [
      { label: 'Ignore downvoted moderator posts', value: MODERATOR_IGNORE },
      {
        label: 'Action all downvoted posts including moderators',
        value: MODERATOR_ACTION_ALL,
      },
    ],
    defaultValue: [MODERATOR_IGNORE],
  },
] satisfies SettingsFormField[]);

function legacyTriggerClients(context: TriggerClients): TriggerClients {
  return {
    reddit: context.reddit,
    redis: context.redis,
    scheduler: context.scheduler,
    settings: context.settings,
  };
}

function legacyScheduledCheckClients(context: unknown): ScheduledCheckClients {
  const clients = context as ScheduledCheckClients;
  return {
    reddit: clients.reddit,
    redis: clients.redis,
    scheduler: clients.scheduler,
    settings: clients.settings,
  };
}

Devvit.addSchedulerJob<{ postId?: string }>({
  name: CHECK_WATCHED_POST_TASK,
  async onRun(event, context) {
    await handleScheduledPostCheck({
      postId: event.data?.postId,
      payload: event.data,
      clients: legacyScheduledCheckClients(context),
      schedulerSource: 'legacy_addSchedulerJob',
    });
  },
});

Devvit.addTrigger({
  event: 'PostSubmit',
  async onEvent(event, context) {
    await handlePostSubmitTrigger({
      input: event,
      clients: legacyTriggerClients(context as TriggerClients),
      triggerSource: 'legacy_addTrigger',
    });
  },
});

Devvit.addTrigger({
  event: 'PostUpdate',
  async onEvent(event, context) {
    await handlePostUpdateTrigger({
      input: event,
      clients: legacyTriggerClients(context as TriggerClients),
      triggerSource: 'legacy_addTrigger',
    });
  },
});

export default Devvit;
