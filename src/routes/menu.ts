import { Hono } from 'hono';
import type { ContextActionResponse } from '@devvit/protos/json/devvit/actor/reddit/context_action.js';
import type { SettingsValues } from '@devvit/web/server';
import { settings as devvitSettings } from '@devvit/web/server';
import { logInfo } from '../core/logging';
import { runRedditDomainProbe } from '../core/redditDomainProbe';
import { readRedditOAuthConfigFromSettings } from '../core/redditOAuthRatio';

export const menu = new Hono();

menu.post('/reddit-domain-probe', async (c) => {
  const settingsValues = await devvitSettings.getAll<SettingsValues>();

  logInfo('Starting temporary Reddit domain probe from subreddit menu.', {
    postId: 't3_1tqgga7',
    subredditName: 'HestiaListens',
  });

  const report = await runRedditDomainProbe({
    config: readRedditOAuthConfigFromSettings(
      settingsValues as Record<string, unknown>
    ),
  });

  logInfo('Temporary Reddit domain probe complete.', {
    postId: report.postId,
    tokenAvailable: report.tokenAvailable,
    resultCount: report.results.length,
    results: report.results,
  });

  const response: ContextActionResponse = {
    success: true,
    message: `Reddit domain probe complete. Check Devvit logs for ${report.results.length} results.`,
    effects: [],
  };

  return c.json(response, 200);
});
