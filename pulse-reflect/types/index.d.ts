/** One learning the check found: a rule, where it belongs, and what happened to it. */
export type Learning = {
  id: string
  /** The rule, one imperative line (English by default; see the ruleLanguage setting). */
  rule: string
  scope: 'global' | 'project'
  /** The session root it was said in. */
  project: string
  /** How many times it was said (the check merges repeats). */
  count: number
  firstAt: number
  lastAt: number
  status: 'pending' | 'saved' | 'skipped'
  confidence: number
  /**
   * Stamp of the last change to its state (save, discard, delete, move, restore, undo), in any session; each change
   * writes a larger one. Undo applies only while this still holds the stamp the undoing session wrote, so a later
   * change anywhere always wins.
   */
  decidedAt?: number
}

/** A rule saved in this session, with where it applies. */
export type SavedRule = { rule: string; scope: 'global' | 'project'; project: string }

/** The last press of Edit rule: the original rule stays waiting, out of the band, until its reworded rule arrives. */
export type LastEdit = { id: string; rule: string; scope: 'global' | 'project'; at: number }

/** The save, discard or delete the band (and the rules pane) offers to undo for 15 seconds. */
export type RecentDecision = {
  kind: 'saved' | 'discarded' | 'deleted'
  /** The learning's id; for a delete, an id of the offer's own. */
  id: string
  rule: string
  scope: 'global' | 'project'
  project: string
  /** The scope and project the learning had before the decision, which an undo puts back. */
  previousScope: 'global' | 'project'
  previousProject: string
  /** The CLAUDE.md a save went to or a delete took the line from; empty for a discard. */
  path: string
  /** False when the file already held a matching bullet, so undo leaves the file alone. */
  isWritten: boolean
  /** The stamp this session's decision wrote on the learning. */
  decidedAt: number
  /** When the undo offer ends. */
  until: number
  /** For a delete: the learnings it marked discarded, with the stamp it wrote on each. */
  affected?: { id: string; decidedAt: number }[]
  /** For a delete: whether the rule was in this session's saved rules, which undo puts back. */
  wasInSession?: boolean
}

/** The last time the rule check could not finish, as the rules pane header shows it. */
export type CheckError = { text: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    'pulse-reflect': {
      /** Pending learnings for this project and global ones, as the band draws them, the head first. */
      pending: Learning[]
      /** Rules saved in this session: the system prompt carries them until CLAUDE.md is read again. */
      savedThisSession: SavedRule[]
      /** The rule at the band's head and when it got there: it stays first while it waits, and the desktop card eases in from `since`. */
      shownHead: { id: string; since: number }
      /** Ids sent to the back with Show next rule, oldest first; emptied once every waiting rule has been shown. */
      sentBack: string[]
      /** Whether the check is paused (the store's `paused`, mirrored for the band). */
      isPaused: boolean
      /** The save or discard the band offers to undo, or null. */
      recent: RecentDecision | null
      /** The last check error in this session, or null. */
      lastError: CheckError | null
      /** Kinds of check error already toasted in this session: each kind toasts once. */
      toastedErrors: string[]
      /** Bumped when saved rules or the store change, so the rules pane draws again. */
      rulesVersion: number
      /** Bumped each second while an undo offer stands, so its countdown draws again. */
      undoTick: number
    }
  }
}
