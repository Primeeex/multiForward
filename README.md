# multiForward

A Vencord userplugin that adds **multi-message forwarding** to Discord. It allows users to select multiple messages and forward them together in a single operation, similar to forwarding multiple messages in other messaging apps.

Instead of forwarding messages individually, `multiForward` provides a streamlined workflow for selecting messages, reviewing the selection, and forwarding them to a destination channel.

## Quick Setup

Upload the plugin folder to the appropriate location in your Vencord source tree, then run:

```powershell
Remove-Item -Recurse -Force dist
pnpm build
pnpm inject
```

After injection, enable `multiForward` in Vencord if needed.

## Installation

1. Put the plugin folder in `src/userplugins/multiForward/`.
2. Export a default `definePlugin` from `index.tsx` or `index.ts`.
3. Use Vencord APIs such as `@api/*`, `@utils/*`, and `@webpack/common`.
4. Integrate with Discord's message context menus and message selection UI.
5. Implement a multi-message selection state to track the messages selected for forwarding.
6. Provide a destination picker for choosing the channel where the selected messages should be forwarded.
7. Rebuild and reinject Vencord after making changes.

For development, `pnpm watch` can be used instead of a full rebuild.

## How It Works

### Message context menu

The plugin integrates with Discord's message context menu:

```text
navId="message"
```

It adds an action such as:

```text
Forward Messages
```

Selecting the action begins the multi-message forwarding workflow.

The exact menu integration depends on the Discord and Vencord APIs available in the installed version.

### Message selection

The plugin maintains a collection of selected messages.

Each selected message should retain the information required for forwarding, such as:

```text
{
    messageId,
    channelId,
    author,
    content,
    attachments,
    timestamp
}
```

The selection workflow should allow users to add messages, remove messages, and review their selection before forwarding.

Messages should be deduplicated by their IDs so that the same message cannot accidentally be added multiple times.

### Selection interface

The plugin should provide a clear interface for managing the selected messages, including:

- A visible indication of how many messages are selected.
- The ability to remove individual messages from the selection.
- An option to cancel the operation.
- A forwarding action that opens the destination picker.

The interface should remain consistent with Discord's existing UI wherever practical.

### Destination selection

When the user chooses to forward the selected messages, the plugin presents a destination channel picker.

The destination picker should:

- Display channels the current user can access.
- Allow the user to select the destination channel.
- Validate the destination before proceeding.
- Provide a final confirmation when appropriate.

After the destination is selected, the plugin processes the selected messages in their original chronological order.

### Forwarding messages

The plugin forwards the selected messages as a single user-initiated operation.

The implementation should preserve the original message order and, where supported, retain relevant message content and attachments.

Depending on the Discord APIs available, forwarding may require using Discord's native forwarding functionality or constructing equivalent messages in the destination channel.

If native forwarding is unavailable for a particular message or attachment, the plugin should handle that case gracefully rather than silently losing content.

The plugin should also handle failed operations, unavailable messages, missing permissions, and invalid destinations.

### Error handling

If forwarding fails, the plugin should inform the user which messages could not be forwarded whenever that information is available.

The implementation should avoid silently discarding selected messages or reporting success when the operation has failed.

## Files

### `index.tsx`

The renderer-side implementation should contain:

- Message context menu integration.
- Multi-message selection state.
- Selection and deselection logic.
- The selection interface.
- Destination channel selection.
- Forwarding orchestration.
- Message ordering and deduplication.
- Error handling and user feedback.

Additional files may be introduced if the implementation requires separate components or utility functions.

## Message Ordering

Selected messages should be forwarded in their original chronological order, regardless of the order in which the user selected them.

For example, if the user selects messages in this order:

```text
Message 3
Message 1
Message 2
```

The resulting forwarding order should be:

```text
Message 1
Message 2
Message 3
```

Where possible, the plugin should use message timestamps or Discord's message ordering conventions to establish the correct order.

Messages from different channels may require separate ordering rules or grouping.

## Permissions and Compatibility

The plugin should respect Discord's existing channel permissions and message restrictions.

It should account for:

- Channels where the user cannot send messages.
- Messages that have been deleted or are no longer accessible.
- Attachments that cannot be re-uploaded or forwarded.
- Discord changes that affect message context menus or forwarding APIs.
- Differences between native message forwarding and recreating a message's content.

The implementation should use supported Vencord APIs wherever possible and avoid relying on undocumented behavior without appropriate error handling.

## Settings

The initial implementation can operate without additional settings.

Optional settings could include:

- Whether to preserve chronological ordering.
- Whether to show a confirmation before forwarding.
- Whether to include message links when native forwarding is unavailable.
- Whether to group forwarded messages by their original channel.

Only expose settings that are actually implemented.

## Context and Selection Limits

The plugin should maintain an explicit selection of messages rather than relying on an arbitrary number of recent messages.

Selection should be cleared after a successful forwarding operation or when the user cancels the workflow.

If Discord imposes message, attachment, or request limits, the plugin should account for them and provide useful feedback when a selection exceeds those limits.

## Notes

- Plugin name: `multiForward`.
- Plugin directory: `src/userplugins/multiForward/`.
- Main entry point: `index.tsx`.
- Primary feature: forwarding multiple messages in one workflow.
- Messages should retain their original chronological order.
- Users should be able to review and modify their selection before forwarding.
- Forwarding should be initiated explicitly by the user.
- Actual forwarding behavior depends on the Discord and Vencord APIs available in the target version.

**Implementation note:** This document describes the intended functionality and architecture, not a verified implementation. Discord's native multi-message forwarding capabilities and internal APIs can change, so the precise forwarding mechanism must be confirmed against the Vencord source version being targeted.
