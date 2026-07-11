import type { Player, PlayerAction } from "./types.js";
import { PlayerStatus } from "./types.js";

/**
 * The set of legal actions available to the player whose turn it is, given the
 * current betting context. This is computed server-side and can be sent to the
 * client to drive the UI — but the server ALWAYS re-validates a submitted
 * action against these rules; it never trusts the client.
 */
export interface LegalActions {
  canFold: boolean;
  canCheck: boolean;
  canCall: boolean;
  /** Chips required to call (0 if canCall is false). Capped at the stack. */
  callAmount: number;
  /** True if the player may open a bet (no outstanding bet to call). */
  canBet: boolean;
  /** True if the player may raise an existing bet. */
  canRaise: boolean;
  /**
   * Minimum legal TOTAL street bet for a bet/raise ("raise to" value). If the
   * player cannot afford this, their only aggressive option is all-in for less.
   */
  minBetTo: number;
  /** Maximum TOTAL street bet — i.e. going all-in. */
  maxBetTo: number;
}

/** Context describing the current betting round, independent of who is acting. */
export interface BettingContext {
  /** Highest street-committed amount by any player (the bet to match). */
  currentBet: number;
  /**
   * Size of the last full raise increment. Preflop this starts at the big
   * blind; it grows as players make full raises. A raise must increase the bet
   * by at least this much (min-raise rule).
   */
  minRaiseSize: number;
  bigBlind: number;
}

/**
 * Compute the legal actions for `player` under `ctx`.
 *
 * Poker rules encoded here:
 *  - If the player already matches the current bet, they may CHECK; otherwise
 *    they must CALL (or fold/raise). You cannot check facing a bet.
 *  - A raise must be to at least currentBet + minRaiseSize, UNLESS the player
 *    does not have enough chips, in which case they may go all-in for less.
 *  - Opening a bet (no current bet) must be at least one big blind, again
 *    unless the player is going all-in for less.
 */
export function computeLegalActions(player: Player, ctx: BettingContext): LegalActions {
  const toCall = Math.max(0, ctx.currentBet - player.streetCommitted);
  const callAmount = Math.min(toCall, player.stack);
  const canCheck = toCall === 0;
  const canCall = toCall > 0 && player.stack > 0;

  // The most the player could put in total on this street if they shoved.
  const maxBetTo = player.streetCommitted + player.stack;

  // Can the player put in more than just a call? Only if they have chips beyond
  // the call amount.
  const hasChipsToAggress = maxBetTo > ctx.currentBet;

  const canBet = ctx.currentBet === 0 && hasChipsToAggress;
  const canRaise = ctx.currentBet > 0 && hasChipsToAggress;

  // Minimum legal "raise to". Facing no bet: one big blind. Facing a bet: the
  // current bet plus a full minimum raise. Either way, capped to what a shove
  // would be (a player can always move all-in even if it's short of a full
  // raise — that's handled by validateAction, but minBetTo reflects the
  // rule-legal minimum here).
  let minBetTo: number;
  if (ctx.currentBet === 0) {
    minBetTo = Math.min(ctx.bigBlind, maxBetTo);
  } else {
    minBetTo = Math.min(ctx.currentBet + ctx.minRaiseSize, maxBetTo);
  }

  return {
    canFold: true,
    canCheck,
    canCall,
    callAmount,
    canBet,
    canRaise,
    minBetTo,
    maxBetTo,
  };
}

export interface ValidationOk {
  ok: true;
  /** Normalized action with a concrete chip delta the engine should apply. */
  normalized: {
    type: PlayerAction["type"];
    /** Total the player's street commitment becomes after this action. */
    betTo: number;
    /** Chips moved from stack to pot by this action. */
    chipsPutIn: number;
    /** True if this action is a full (betting-reopening) raise. */
    isFullRaise: boolean;
    /** True if the action puts the player all-in. */
    allIn: boolean;
  };
}
export interface ValidationErr {
  ok: false;
  error: string;
}
export type ValidationResult = ValidationOk | ValidationErr;

/**
 * Validate and normalize a submitted action. This is the authoritative gate:
 * the engine calls this before mutating any state. It returns either a
 * normalized action (with concrete chip amounts) or an error message.
 *
 * The `isFullRaise` flag matters for the min-raise rule: an all-in that is
 * short of a full raise does NOT reopen the betting for players who have
 * already acted, and does NOT increase minRaiseSize. The engine uses this flag
 * to decide whether previously-acted players get another turn.
 */
export function validateAction(
  player: Player,
  action: PlayerAction,
  ctx: BettingContext,
): ValidationResult {
  const legal = computeLegalActions(player, ctx);

  switch (action.type) {
    case "fold":
      return {
        ok: true,
        normalized: {
          type: "fold",
          betTo: player.streetCommitted,
          chipsPutIn: 0,
          isFullRaise: false,
          allIn: false,
        },
      };

    case "check":
      if (!legal.canCheck) return err("Cannot check facing a bet");
      return {
        ok: true,
        normalized: {
          type: "check",
          betTo: player.streetCommitted,
          chipsPutIn: 0,
          isFullRaise: false,
          allIn: false,
        },
      };

    case "call": {
      if (!legal.canCall) return err("Nothing to call");
      const chips = legal.callAmount;
      const betTo = player.streetCommitted + chips;
      return {
        ok: true,
        normalized: {
          type: "call",
          betTo,
          chipsPutIn: chips,
          isFullRaise: false,
          allIn: chips === player.stack,
        },
      };
    }

    case "bet":
    case "raise": {
      const isOpen = ctx.currentBet === 0;
      if (isOpen && action.type !== "bet") return err("Use 'bet' to open; nothing to raise");
      if (!isOpen && action.type !== "raise") return err("Facing a bet — use 'raise'");
      if (isOpen && !legal.canBet) return err("Cannot bet");
      if (!isOpen && !legal.canRaise) return err("Cannot raise");

      const betTo = action.amount;
      if (betTo === undefined || !Number.isFinite(betTo)) {
        return err("bet/raise requires an amount");
      }
      if (!Number.isInteger(betTo)) return err("Bet amount must be a whole number of chips");

      const chipsPutIn = betTo - player.streetCommitted;
      if (chipsPutIn <= 0) return err("Bet must increase your commitment");
      if (chipsPutIn > player.stack) return err("Not enough chips");

      const allIn = chipsPutIn === player.stack;

      // Must at least match the current bet.
      if (betTo < ctx.currentBet) return err("Raise must at least match the current bet");
      if (betTo === ctx.currentBet) return err("A raise must exceed the current bet");

      // The raise increment over the current bet.
      const raiseIncrement = betTo - ctx.currentBet;
      const fullRaiseIncrement = isOpen ? ctx.bigBlind : ctx.minRaiseSize;

      if (raiseIncrement < fullRaiseIncrement) {
        // Short of a full raise is only allowed as an all-in for less.
        if (!allIn) {
          return err(
            `Minimum ${isOpen ? "bet" : "raise to"} is ${
              isOpen ? ctx.bigBlind : ctx.currentBet + ctx.minRaiseSize
            }`,
          );
        }
        // Legal all-in under-raise: does not reopen betting.
        return {
          ok: true,
          normalized: {
            type: action.type,
            betTo,
            chipsPutIn,
            isFullRaise: false,
            allIn: true,
          },
        };
      }

      // A full, betting-reopening raise.
      return {
        ok: true,
        normalized: {
          type: action.type,
          betTo,
          chipsPutIn,
          isFullRaise: true,
          allIn,
        },
      };
    }

    default:
      return err(`Unknown action type: ${(action as PlayerAction).type}`);
  }
}

function err(message: string): ValidationErr {
  return { ok: false, error: message };
}

/** Players who are able to voluntarily act (not folded, all-in, or sitting out). */
export function canAct(player: Player): boolean {
  return player.status === PlayerStatus.Active;
}
