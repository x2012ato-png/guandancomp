"""Adapter between `@guandan/engine` (PlayerView + legal choices) and DanZero's 567-dim feature vector.

Also supports the simple standalone REST contract (`hand_cards`, `last_move`, `played_cards_history`, etc.)
and the stateful/stateless `ExternalAI` payload (`mode: 'snapshot' | 'incremental'`).
"""

from __future__ import annotations

from collections import Counter
from typing import Any

import numpy as np

# DanZero's CardToNum mapping:
# H2..HA -> 0..12
# S2..SA -> 13..25
# C2..CA -> 26..38
# D2..DA -> 39..51
# SB -> 52, HR -> 53
DANZERO_CARD_TO_NUM: dict[str, int] = {
    "H2": 0, "H3": 1, "H4": 2, "H5": 3, "H6": 4, "H7": 5, "H8": 6, "H9": 7, "HT": 8, "HJ": 9, "HQ": 10, "HK": 11, "HA": 12,
    "S2": 13, "S3": 14, "S4": 15, "S5": 16, "S6": 17, "S7": 18, "S8": 19, "S9": 20, "ST": 21, "SJ": 22, "SQ": 23, "SK": 24, "SA": 25,
    "C2": 26, "C3": 27, "C4": 28, "C5": 29, "C6": 30, "C7": 31, "C8": 32, "C9": 33, "CT": 34, "CJ": 35, "CQ": 36, "CK": 37, "CA": 38,
    "D2": 39, "D3": 40, "D4": 41, "D5": 42, "D6": 43, "D7": 44, "D8": 45, "D9": 46, "DT": 47, "DJ": 48, "DQ": 49, "DK": 50, "DA": 51,
    "SB": 52, "HR": 53,
}

# `@guandan/engine` CardId (0..107):
# deck = id // 54, i = id % 54
# i in 0..51: SUITS = ['S', 'H', 'C', 'D'], suit = SUITS[i // 13], rank = 2 + (i % 13) (14=A)
# i == 52: Small Joker ('SB'), i == 53: Big Joker ('HR')
ENGINE_SUITS = ("S", "H", "C", "D")
RANK_NUM_TO_CHAR: dict[int, str] = {
    2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9",
    10: "T", 11: "J", 12: "Q", 13: "K", 14: "A", 16: "B", 17: "R",
}
RANK_CHAR_TO_INDEX: dict[str, int] = {
    "2": 1, "3": 2, "4": 3, "5": 4, "6": 5, "7": 6, "8": 7, "9": 8,
    "T": 9, "J": 10, "Q": 11, "K": 12, "A": 13,
}


def engine_card_id_to_str(card_id: int) -> str:
    """Convert `@guandan/engine` CardId (0..107) to DanZero card string ('H5', 'SB', 'HR')."""
    i = int(card_id) % 54
    if i == 52:
        return "SB"
    if i == 53:
        return "HR"
    suit = ENGINE_SUITS[i // 13]
    rank = 2 + (i % 13)
    return f"{suit}{RANK_NUM_TO_CHAR[rank]}"


def engine_card_id_to_danzero_num(card_id: int) -> int:
    """Convert `@guandan/engine` CardId (0..107) directly to DanZero card index (0..53)."""
    return DANZERO_CARD_TO_NUM[engine_card_id_to_str(card_id)]


def card_str_to_danzero_num(card_str: str) -> int:
    """Convert card string ('H5', 'H10', 'HT', 'SB', 'SJ', 'BJ', 'HR') to DanZero card index (0..53)."""
    s = card_str.strip().upper()
    if s in ("SB", "SJ", "小王"):
        return 52
    if s in ("HR", "BJ", "RJ", "大王"):
        return 53
    # Support Unicode suit prefixes from cardLabel: ♠, ♥, ♣, ♦
    suit_map = {"♠": "S", "♥": "H", "♣": "C", "♦": "D"}
    if s and s[0] in suit_map:
        s = suit_map[s[0]] + s[1:]
    if len(s) == 3 and s[1:] == "10":
        s = s[0] + "T"
    if s not in DANZERO_CARD_TO_NUM:
        raise ValueError(f"Unrecognized card string: {card_str!r}")
    return DANZERO_CARD_TO_NUM[s]


def card2array(list_cards: list[int] | None) -> np.ndarray:
    """Exact replica of DanZero's `danutil.card2array`."""
    if list_cards is None or len(list_cards) == 0:
        return np.zeros(54, dtype=np.int8)
    if list_cards == [-1]:
        return -1 * np.ones(54, dtype=np.int8)
    matrix = np.zeros((4, 13), dtype=np.int8)
    jokers = np.zeros(2, dtype=np.int8)
    counter = Counter(list_cards)
    for card, num_times in counter.items():
        if card == -1:
            continue
        if 0 <= card < 52:
            matrix[card // 13, card % 13] = num_times
        elif card == 52:
            jokers[0] = num_times
        elif card == 53:
            jokers[1] = num_times
    return np.concatenate((matrix.flatten("F"), jokers))


def get_one_hot_array(num_left_cards: int, max_num_cards: int, flag: int) -> np.ndarray:
    """Exact replica of DanZero's `_get_one_hot_array`."""
    if flag == 0:  # Rank level (1..13)
        one_hot = np.zeros(max_num_cards, dtype=np.int8)
        idx = max(0, min(max_num_cards - 1, int(num_left_cards) - 1))
        one_hot[idx] = 1
    else:  # Remaining cards count (0..27)
        one_hot = np.zeros(max_num_cards + 1, dtype=np.int8)
        idx = max(0, min(max_num_cards, int(num_left_cards)))
        one_hot[idx] = 1
    return one_hot


def proc_universal(hand_cards_array: np.ndarray, cur_rank_idx: int) -> np.ndarray:
    """Exact replica of DanZero's `DanzeroAgent.proc_universal` (12-dim wildcard feature).

    Args:
        hand_cards_array: 54-dim array from `card2array`.
        cur_rank_idx: 1..13 (where '2'->1, ..., 'A'->13).
    """
    res = np.zeros(12, dtype=np.int8)
    wild_pos = (cur_rank_idx - 1) * 4  # Heart of cur_rank in Fortran-flattened 4x13 matrix
    if hand_cards_array[wild_pos] == 0:
        return res

    res[0] = 1
    rock_flag = 0
    for i in range(4):
        left, right = 0, 5
        temp = [hand_cards_array[i + j * 4] if i + j * 4 != wild_pos else 0 for j in range(5)]
        while right <= 12:
            zero_num = temp.count(0)
            if zero_num <= 1:
                rock_flag = 1
                break
            else:
                temp.append(hand_cards_array[i + right * 4] if i + right * 4 != wild_pos else 0)
                temp.pop(0)
                left += 1
                right += 1
        if rock_flag == 1:
            break
    res[1] = rock_flag

    num_count = [0] * 13
    for i in range(4):
        for j in range(13):
            if hand_cards_array[i + j * 4] != 0 and i + j * 4 != wild_pos:
                num_count[j] += 1
    num_max = max(num_count)
    if num_max >= 6:
        res[2:8] = 1
    elif num_max == 5:
        res[3:8] = 1
    elif num_max == 4:
        res[4:8] = 1
    elif num_max == 3:
        res[5:8] = 1
    elif num_max == 2:
        res[6:8] = 1
    else:
        res[7] = 1

    temp_run = 0
    for i in range(13):
        if num_count[i] != 0:
            temp_run += 1
            if i >= 1:
                if (num_count[i] == 2 and num_count[i - 1] >= 3) or (num_count[i] >= 3 and num_count[i - 1] == 2):
                    res[9] = 1
                elif num_count[i] == 2 and num_count[i - 1] == 2:
                    res[11] = 1
            if i >= 2:
                if (
                    (num_count[i - 2] == 1 and num_count[i - 1] >= 2 and num_count[i] >= 2)
                    or (num_count[i - 2] >= 2 and num_count[i - 1] == 1 and num_count[i] >= 2)
                    or (num_count[i - 2] >= 2 and num_count[i - 1] >= 2 and num_count[i] == 1)
                ):
                    res[10] = 1
        else:
            temp_run = 0
    if temp_run >= 4:
        res[8] = 1
    return res


def level_to_rank_idx(level: int | str) -> int:
    """Convert engine level (2..14 or '2'..'A') to DanZero 1-based rank index (1..13)."""
    if isinstance(level, int):
        return max(1, min(13, level - 1))
    s = str(level).strip().upper()
    if s == "10":
        s = "T"
    if s in RANK_CHAR_TO_INDEX:
        return RANK_CHAR_TO_INDEX[s]
    return max(1, min(13, int(s) - 1))


def build_danzero_batch_from_player_view(
    view: dict[str, Any],
    choices: list[dict[str, Any]],
) -> np.ndarray:
    """Build DanZero's (num_actions, 567) feature matrix from `@guandan/engine` PlayerView and legal choices.

    Feature layout (567 dims total):
      1. my_handcards          (54)
      2. universal_card_flag   (12)
      3. other_handcards       (54)
      4. last_action           (54)
      5. last_teammate_action  (54)
      6. down_played_cards     (54)
      7. teammate_played_cards (54)
      8. up_played_cards       (54)
      9. down_num_cards_left   (28)
     10. teammate_num_cards_left (28)
     11. up_num_cards_left     (28)
     12. self_rank             (13)
     13. oppo_rank             (13)
     14. cur_rank              (13)
     15. my_action             (54)
    """
    num_legal_actions = len(choices)
    my_seat = int(view["seat"])
    down_seat = (my_seat + 1) % 4
    teammate_seat = (my_seat + 2) % 4
    up_seat = (my_seat + 3) % 4

    # 1. Own hand cards (54)
    my_hand_nums = [engine_card_id_to_danzero_num(cid) for cid in view["myHand"]]
    my_handcards = card2array(my_hand_nums)

    # 2. Universal card flag (12)
    cur_rank_idx = level_to_rank_idx(view["level"])
    universal_card_flag = proc_universal(my_handcards, cur_rank_idx)

    # 3. Other players' remaining unseen cards (54)
    # Full double deck has 2 of each of the 54 card types.
    other_left_counts = [2] * 54
    for cnum in my_hand_nums:
        other_left_counts[cnum] = max(0, other_left_counts[cnum] - 1)
    for cid in view.get("playedCards", []):
        cnum = engine_card_id_to_danzero_num(cid)
        other_left_counts[cnum] = max(0, other_left_counts[cnum] - 1)

    other_hands_list: list[int] = []
    for cnum, cnt in enumerate(other_left_counts):
        if cnt == 1:
            other_hands_list.append(cnum)
        elif cnt >= 2:
            other_hands_list.append(cnum)
            other_hands_list.append(cnum)
    other_handcards = card2array(other_hands_list)

    # Reconstruct per-seat action history from `publicHistory` matching `DanzeroAgent.received_message()`
    # Important: in DanZero (`danzero_agent.py` lines 357-395), when 1 or 2 players have already finished (`over`),
    # `DanzeroAgent` inserts `[-1]` into the finished player's `history_action` and `action_seq` on each trick step!
    public_history = view.get("publicHistory") or []
    history_action: dict[int, list[list[int]]] = {0: [], 1: [], 2: [], 3: []}
    action_seq: list[list[int]] = []

    if public_history:
        for idx, entry in enumerate(public_history):
            s = int(entry["seat"])
            play = entry.get("play")
            act_nums = [-1] if play is None else [engine_card_id_to_danzero_num(cid) for cid in play["cards"]]
            history_action[s].append(act_nums)
            if s != my_seat:
                action_seq.append(act_nums)
            # If the next entry in public_history skips a seat (because that seat finished earlier),
            # insert `[-1]` for skipped seats so `action_seq` and `history_action` stay aligned with DanZero's 4-seat cycle.
            if idx + 1 < len(public_history):
                next_s = int(public_history[idx + 1]["seat"])
                cur = (s + 1) % 4
                steps_checked = 0
                while cur != next_s and steps_checked < 3:
                    history_action[cur].append([-1])
                    if cur != my_seat:
                        action_seq.append([-1])
                    cur = (cur + 1) % 4
                    steps_checked += 1
        # Also check between the last public_history entry and current `my_seat`
        last_s = int(public_history[-1]["seat"])
        cur = (last_s + 1) % 4
        steps_checked = 0
        while cur != my_seat and steps_checked < 3:
            history_action[cur].append([-1])
            if cur != my_seat:
                action_seq.append([-1])
            cur = (cur + 1) % 4
            steps_checked += 1

    # Fallback if `publicHistory` was empty but `trick` has history
    if not public_history and view.get("trick") and view["trick"].get("history"):
        for entry in view["trick"]["history"]:
            s = int(entry["seat"])
            play = entry.get("play")
            act_nums = [-1] if play is None else [engine_card_id_to_danzero_num(cid) for cid in play["cards"]]
            history_action[s].append(act_nums)
            if s != my_seat:
                action_seq.append(act_nums)

    # 4. Last action (54)
    # Note: in DanZero, if `action_seq` has entries, if the latest is PASS ([-1]), `card2array([])` (zeros) is used;
    # if no actions have been taken yet at the start of the deal, `card2array([-1])` (-1s) is used.
    if len(action_seq) > 0:
        if action_seq[-1] == [-1]:
            last_action = card2array([])
        else:
            last_action = card2array(action_seq[-1])
    elif view.get("trick") and view["trick"].get("lastPlay"):
        lp_cards = view["trick"]["lastPlay"]["play"]["cards"]
        last_action = card2array([engine_card_id_to_danzero_num(cid) for cid in lp_cards])
    else:
        last_action = card2array([-1])

    # 5. Last teammate action (54)
    finish_order = view.get("finishOrder") or []
    hand_counts = view.get("handCounts") or [27, 27, 27, 27]
    teammate_out = (teammate_seat in finish_order) or (hand_counts[teammate_seat] == 0)
    if len(history_action[teammate_seat]) > 0 and not teammate_out:
        last_teammate_action = card2array(history_action[teammate_seat][-1])
    else:
        last_teammate_action = card2array([-1])

    # 6, 7, 8. Down / Teammate / Up played cards (54 each)
    # Important: in DanZero's `prepare()`, it calls `card2array(reduce(lambda x, y: x+y, self.history_action[seat]))`.
    # When a seat has ONLY passed so far, `reduce` produces `[-1]` (if 1 pass) or `[-1, -1, ...]` (if multiple passes).
    # In `card2array`, `if list_cards == [-1]: return -1 * np.ones(54)`!
    def seat_played_array(seat_id: int) -> np.ndarray:
        if not history_action[seat_id]:
            return card2array([])
        flat: list[int] = []
        for act in history_action[seat_id]:
            flat.extend(act)
        return card2array(flat)

    down_played_cards = seat_played_array(down_seat)
    teammate_played_cards = seat_played_array(teammate_seat)
    up_played_cards = seat_played_array(up_seat)

    # 9, 10, 11. Remaining card counts one-hot (28 each)
    down_num_cards_left = get_one_hot_array(hand_counts[down_seat], 27, 1)
    teammate_num_cards_left = get_one_hot_array(hand_counts[teammate_seat], 27, 1)
    up_num_cards_left = get_one_hot_array(hand_counts[up_seat], 27, 1)

    # 12, 13, 14. Self rank, Oppo rank, Current rank one-hot (13 each)
    team_levels = view.get("teamLevels") or [view["level"], view["level"]]
    self_level_idx = level_to_rank_idx(team_levels[my_seat % 2])
    oppo_level_idx = level_to_rank_idx(team_levels[(my_seat + 1) % 2])
    self_rank = get_one_hot_array(self_level_idx, 13, 0)
    oppo_rank = get_one_hot_array(oppo_level_idx, 13, 0)
    cur_rank = get_one_hot_array(cur_rank_idx, 13, 0)

    # Base 513-dim state vector (shared across all candidate actions)
    state_vec = np.concatenate([
        my_handcards,
        universal_card_flag,
        other_handcards,
        last_action,
        last_teammate_action,
        down_played_cards,
        teammate_played_cards,
        up_played_cards,
        down_num_cards_left,
        teammate_num_cards_left,
        up_num_cards_left,
        self_rank,
        oppo_rank,
        cur_rank,
    ])
    state_batch = np.repeat(state_vec[np.newaxis, :], num_legal_actions, axis=0)

    # 15. Candidate actions batch (num_legal_actions, 54)
    # Note: In DanZero (`danzero_agent.py`), PASS is `['PASS', 'PASS', 'PASS']`,
    # and `legal_actions = [card2num(i[2]) for i in message['actionList']]`.
    # Because `'P'` and `'A'` and `'S'` are not in `CardToNum`, `card2num('PASS')` returns `[]`!
    # And `card2array([])` is `np.zeros(54)` (all 0s, NOT -1s)!
    my_action_batch = np.zeros((num_legal_actions, 54), dtype=np.int8)
    for j, choice in enumerate(choices):
        action_type = choice.get("action")
        if action_type == "不要" or choice.get("type") == "pass":
            my_action_batch[j, :] = card2array([])
        else:
            if "cardIds" in choice:
                cnums = [engine_card_id_to_danzero_num(cid) for cid in choice["cardIds"]]
            elif "cards" in choice:
                cnums = [card_str_to_danzero_num(cs) for cs in choice["cards"]]
            else:
                cnums = []
            my_action_batch[j, :] = card2array(cnums)

    return np.hstack((state_batch, my_action_batch))


def expand_choices_for_danzero(
    view: dict[str, Any],
    choices: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[int]]:
    """Expand representative `choices` from `@guandan/engine` to include alternative card combinations
    (e.g., different suits for singles/pairs/trips/fullHouse) from `view['myHand']`,
    mapping each expanded candidate back to its original index in `choices`.

    Why this matters for DanZero:
    DanZero's Q-network takes the exact 54-dim card vector of the candidate action (`my_action_batch`).
    `@guandan/engine`'s `generatePlays()` deduplicates by combo signature and always picks the first suit
    in `['S', 'H', 'C', 'D']` order—which can inadvertently pick a card that belongs to a StraightFlush!
    Expanding same-rank suit combinations allows DanZero's Q-network to evaluate and pick the suit
    combination that preserves straight flushes and hand structure.
    """
    my_hand = view.get("myHand") or []
    if len(my_hand) <= 1 or len(choices) <= 1:
        return choices, list(range(len(choices)))

    # Group non-wild hand cards by natural rank (2..17)
    level = int(view.get("level", 2))
    by_rank: dict[int, list[int]] = {}
    for cid in my_hand:
        i = int(cid) % 54
        suit = ENGINE_SUITS[i // 13] if i < 52 else "J"
        rank = 16 if i == 52 else 17 if i == 53 else 2 + (i % 13)
        if suit == "H" and rank == level:
            continue  # wildcard
        by_rank.setdefault(rank, []).append(int(cid))

    expanded_choices: list[dict[str, Any]] = []
    parent_indices: list[int] = []

    for orig_idx, choice in enumerate(choices):
        expanded_choices.append(choice)
        parent_indices.append(orig_idx)

        if choice.get("action") == "不要" or choice.get("type") == "pass":
            continue
        combo = choice.get("comboData") or {}
        ctype = combo.get("type")
        cids = choice.get("cardIds") or []
        wilds = choice.get("wildAssignments") or []
        if wilds:
            continue  # keep wildcard plays as-is

        # For Single or Pair without wildcards, add distinct suit combinations from hand
        if ctype == "single" and len(cids) == 1:
            cid0 = int(cids[0])
            i0 = cid0 % 54
            if i0 < 52:
                r = 2 + (i0 % 13)
                seen_suits = {i0 // 13}
                for alt_cid in by_rank.get(r, []):
                    s_idx = (alt_cid % 54) // 13
                    if s_idx not in seen_suits:
                        seen_suits.add(s_idx)
                        expanded_choices.append({**choice, "cardIds": [alt_cid]})
                        parent_indices.append(orig_idx)
        elif ctype == "pair" and len(cids) == 2:
            cid0, cid1 = int(cids[0]), int(cids[1])
            i0 = cid0 % 54
            if i0 < 52:
                r = 2 + (i0 % 13)
                pool = by_rank.get(r, [])
                if len(pool) >= 3:
                    orig_pair = tuple(sorted((cid0 % 54, cid1 % 54)))
                    seen_pairs = {orig_pair}
                    for a_idx in range(len(pool)):
                        for b_idx in range(a_idx + 1, len(pool)):
                            ca, cb = pool[a_idx], pool[b_idx]
                            sig = tuple(sorted((ca % 54, cb % 54)))
                            if sig not in seen_pairs:
                                seen_pairs.add(sig)
                                expanded_choices.append({**choice, "cardIds": [ca, cb]})
                                parent_indices.append(orig_idx)

    return expanded_choices, parent_indices


def choose_tribute_or_return(
    view: dict[str, Any],
    choices: list[dict[str, Any]],
) -> int:
    """Deterministic tribute / return-tribute selector matching DanZero's `tribute_act` and `back_act`."""
    if len(choices) <= 1:
        return 0

    duty = view.get("myDuty") or view.get("phase")
    level_rank_idx = level_to_rank_idx(view.get("level", 2))

    # Extract card info for each choice
    choice_cards: list[tuple[int, str, int]] = []  # (choice_idx, suit, natural_rank_num)
    for idx, ch in enumerate(choices):
        cid = ch.get("cardId")
        if cid is not None:
            cstr = engine_card_id_to_str(int(cid))
        else:
            cnum = card_str_to_danzero_num(ch.get("card", "S2"))
            for k, v in DANZERO_CARD_TO_NUM.items():
                if v == cnum:
                    cstr = k
                    break
            else:
                cstr = "S2"
        suit = cstr[0]
        rchar = cstr[1:]
        rnum = 16 if cstr == "SB" else 17 if cstr == "HR" else RANK_CHAR_TO_INDEX.get(rchar, 1) + 1
        choice_cards.append((idx, suit, rnum))

    if duty == "tribute":
        # Prefer non-heart if multiple suits of biggest card exist
        for idx, suit, _ in choice_cards:
            if suit != "H":
                return idx
        return 0

    # For `return` (back_act): prefer singletons (cards whose rank appears only once in hand)
    # and smallest rank <= 10, avoiding decomposing pairs/trips/bombs.
    hand_rank_counts: Counter[int] = Counter()
    for cid in view.get("myHand", []):
        i = int(cid) % 54
        r = 16 if i == 52 else 17 if i == 53 else 2 + (i % 13)
        hand_rank_counts[r] += 1

    # Sort candidates by: (count_in_hand, rank_num) so singletons of low rank come first
    best_idx = min(
        choice_cards,
        key=lambda item: (
            hand_rank_counts.get(item[2], 1),
            15 if (item[2] - 1) == level_rank_idx else item[2],
        ),
    )[0]
    return best_idx
