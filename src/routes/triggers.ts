import { Hono } from 'hono';
import type {
  OnPostSubmitRequest,
  OnPostUpdateRequest,
  TriggerResponse,
} from '@devvit/web/shared';
import {
  reddit,
  redis,
  scheduler,
  settings as devvitSettings,
} from '@devvit/web/server';
import {
  handlePostSubmitTrigger,
  handlePostUpdateTrigger,
  type TriggerClients,
} from '../core/triggerHandlers';
import { CHECK_WATCHED_POST_TASK } from '../core/constants';

export const triggers = new Hono();

const webTriggerClients: TriggerClients = {
  reddit,
  redis,
  scheduler,
  settings: devvitSettings,
};

triggers.post('/on-post-submit', async (c) => {
  const input = await c.req.json<OnPostSubmitRequest>();
  await handlePostSubmitTrigger({
    input,
    clients: webTriggerClients,
    triggerSource: 'web_endpoint',
  });

  return c.json<TriggerResponse>({}, 200);
});

triggers.post('/on-post-update', async (c) => {
  const input = await c.req.json<OnPostUpdateRequest>();
  await handlePostUpdateTrigger({
    input,
    clients: webTriggerClients,
    triggerSource: 'web_endpoint',
  });

  return c.json<TriggerResponse>({}, 200);
});

export { CHECK_WATCHED_POST_TASK };
