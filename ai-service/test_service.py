"""Unit tests for DanZero DMC inference service (`ai-service/`)."""

from __future__ import annotations

import json
import unittest

import numpy as np

from adapter import (
    DANZERO_CARD_TO_NUM,
    build_danzero_batch_from_player_view,
    card2array,
    choose_tribute_or_return,
    engine_card_id_to_danzero_num,
    engine_card_id_to_str,
    proc_universal,
)
from main import SERVICE


class TestDanZeroAdapterAndModel(unittest.TestCase):
    def test_card_id_mapping_consistency(self) -> None:
        # Engine CardId 0 is S2 ('S2' -> 13 in DanZero)
        self.assertEqual(engine_card_id_to_str(0), "S2")
        self.assertEqual(engine_card_id_to_danzero_num(0), 13)
        # Engine CardId 13 is H2 ('H2' -> 0 in DanZero)
        self.assertEqual(engine_card_id_to_str(13), "H2")
        self.assertEqual(engine_card_id_to_danzero_num(13), 0)
        # Engine CardId 52 is Small Joker ('SB' -> 52)
        self.assertEqual(engine_card_id_to_str(52), "SB")
        self.assertEqual(engine_card_id_to_danzero_num(52), 52)
        # Engine CardId 53 is Big Joker ('HR' -> 53)
        self.assertEqual(engine_card_id_to_str(53), "HR")
        self.assertEqual(engine_card_id_to_danzero_num(53), 53)
        # Second deck (54..107) maps identically
        for cid in range(54):
            self.assertEqual(
                engine_card_id_to_danzero_num(cid),
                engine_card_id_to_danzero_num(cid + 54),
            )

    def test_card2array_fortran_order(self) -> None:
        # H2 (0), S2 (13), C2 (26), D2 (39) should occupy indices 0, 1, 2, 3 of the 54-dim vector!
        arr = card2array([0, 13, 26, 39, 52, 53])
        self.assertEqual(arr.shape, (54,))
        self.assertEqual(list(arr[:4]), [1, 1, 1, 1])
        self.assertEqual(list(arr[52:54]), [1, 1])

    def test_proc_universal_wildcard(self) -> None:
        # Level 2 ('2' -> rank_idx 1): wildcard is H2 (index 0 in 54-dim array)
        arr_no_wild = card2array([13, 26])  # S2, C2
        u0 = proc_universal(arr_no_wild, 1)
        self.assertEqual(u0.shape, (12,))
        self.assertEqual(int(u0[0]), 0)

        arr_with_wild = card2array([0, 13, 26])  # H2 (wild), S2, C2
        u1 = proc_universal(arr_with_wild, 1)
        self.assertEqual(int(u1[0]), 1)

    def test_feature_batch_567_and_inference(self) -> None:
        view = {
            "seat": 0,
            "phase": "playing",
            "handNo": 1,
            "teamLevels": [2, 2],
            "level": 2,
            "myHand": [0, 1, 2, 13, 26, 52, 53],
            "handCounts": [7, 27, 27, 27],
            "turn": 0,
            "trick": {"leader": 0, "lastPlay": None, "passed": [], "history": []},
            "publicHistory": [],
            "finishOrder": [],
            "playedCards": [],
            "myDuty": "play",
        }
        choices = [
            {"index": 0, "action": "出牌", "cardIds": [0]},
            {"index": 1, "action": "出牌", "cardIds": [1]},
            {"index": 2, "action": "出牌", "cardIds": [0, 26]},
            {"index": 3, "action": "出牌", "cardIds": [53]},
        ]
        x_batch = build_danzero_batch_from_player_view(view, choices)
        self.assertEqual(x_batch.shape, (4, 567))

        res = SERVICE.decide(view, choices)
        self.assertIn("choice", res)
        self.assertTrue(0 <= res["choice"] < 4)
        self.assertLess(res["latency_ms"], 50.0)

    def test_tribute_and_return(self) -> None:
        view_return = {
            "seat": 0,
            "phase": "return",
            "level": 5,
            "myHand": [1, 2, 55, 10],  # S3, S4, S3(deck2), SQ
            "myDuty": "return",
        }
        choices = [
            {"index": 0, "action": "还贡", "cardId": 1},  # S3 (part of a pair)
            {"index": 1, "action": "还贡", "cardId": 2},  # S4 (singleton!)
        ]
        # Should prefer returning S4 (index 1) over breaking the S3 pair
        idx = choose_tribute_or_return(view_return, choices)
        self.assertEqual(idx, 1)


if __name__ == "__main__":
    unittest.main()
