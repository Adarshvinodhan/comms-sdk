import type { MessageReaction } from './types.js';

/** Reactions grouped by emoji, ready to render as chips like "👍 2". */
export interface ReactionSummary {
  emoji: string;
  count: number;
  userIds: string[];
  /** True when `myUserId` is one of `userIds`. */
  mine: boolean;
}

/** Groups a message's reactions by emoji, in the order each emoji was first used. */
export function summarizeReactions(reactions: readonly MessageReaction[], myUserId?: string): ReactionSummary[] {
  const groups = new Map<string, ReactionSummary>();
  for (const r of reactions) {
    const g = groups.get(r.emoji) ?? { emoji: r.emoji, count: 0, userIds: [], mine: false };
    g.count += 1;
    g.userIds.push(r.userId);
    if (r.userId === myUserId) g.mine = true;
    groups.set(r.emoji, g);
  }
  return [...groups.values()];
}

/** The emoji `userId` currently reacted with, or `null`. */
export function reactionOf(reactions: readonly MessageReaction[], userId: string): string | null {
  return reactions.find((r) => r.userId === userId)?.emoji ?? null;
}
