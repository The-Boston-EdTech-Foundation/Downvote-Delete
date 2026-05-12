# downvote-delete

`downvote-delete` is a Devvit moderation app for bulk comment cleanup. It uses Devvit web, Hono, and TypeScript to provide moderator-only tools for removing and locking comment threads or all comments on a post.

## Features

This app includes a working mod tool called **"Mop"**:

- **Bulk Comment Management**: Remove or lock multiple comments at once
- **Thread-level Actions**: "Mop comments" - Remove/lock a comment and all its replies
- **Post-level Actions**: "Mop post comments" - Remove/lock all comments on a post
- **Flexible Options**:
  - Remove comments, lock comments, or both
  - Skip distinguished comments (moderator/admin posts)
- **Permission Checks**: Only moderators with proper permissions can use the tool
- **User-friendly Forms**: Interactive forms with clear options and validation

## Tech Stack

- [Devvit](https://developers.reddit.com/): Reddit's platform for building and deploying apps
- [Vite](https://vite.dev/): Fast build tool for the web components
- [Hono](https://hono.dev/): Lightweight web framework for backend logic
- [TypeScript](https://www.typescriptlang.org/): Type-safe development

## Getting Started

1. **Install dependencies**:
   ```bash
   npm install
   ```
2. **Confirm the app slug** in `devvit.json` is `downvote-delete`
3. **Start developing**:
   ```bash
   npm run dev
   ```
4. **Test your changes** in your development subreddit

## Project Structure

```
src/
├── index.ts          # Main server setup with Hono routes
├── core/
│   └── nuke.ts       # Core moderation logic for bulk operations
└── routes/
    ├── api.ts        # Public API endpoints
    ├── forms.ts      # Form submission handlers
    ├── menu.ts       # Context menu item handlers
    └── triggers.ts   # App lifecycle triggers
```

## Customizing The Mod Tool

The app is designed to be easily customizable:

1. **Modify existing actions**: Edit the nuke functionality in `src/core/nuke.ts`
2. **Add new menu items**: Update `devvit.json` and add handlers in `src/routes/menu.ts`
3. **Create new forms**: Add form definitions and handlers in `src/routes/forms.ts`
4. **Add API endpoints**: Extend `src/routes/api.ts` for external integrations

## Commands

- `npm run dev`: Starts Devvit playtest for your configured development subreddit
- `npm run build`: Builds your mod tool for production with `vite build`
- `npm run validate`: Runs linting, type checking, tests, and the production build
- `npm run deploy`: Uploads a new version of your app to Reddit
- `npm run launch`: Publishes your app for review and public use
- `npm run login`: Authenticates your CLI with Reddit
- `npm run type-check`: Runs TypeScript type checking with `tsc --noEmit`
- `devvit.json` scripts: Devvit uses `vite build --watch` for playtest rebuilds and `vite build` for production builds

## How It Works

The app handles Reddit moderator workflows through the "Mop" feature:

1. **Context Menu Integration**: Click on the Mod Shield icon in a comment to see custom mod actions
2. **Permission Validation**: Automatically checks if the user has moderation permissions
3. **Interactive Forms**: Presents options through Reddit's native form system
4. **Reddit API**: Processes multiple comments using Reddit's API

## Development Notes

- **Permissions**: The app requires `reddit: true` permission to access Reddit's API
- **User Types**: Menu items are restricted to `moderator` user type

## Deployment

1. Test thoroughly in your development subreddit
2. Run `npm run deploy` to upload your app
3. Use `npm run launch` to submit for Reddit's app review process
4. Once approved, users can install your mod tool from Reddit's app directory

This app is configured for the existing Devvit app slug `downvote-delete`.
