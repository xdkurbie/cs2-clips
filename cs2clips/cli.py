"""Headless: python -m cs2clips.cli demo.dem [--player X] [--rules rules.yaml]"""
import argparse
from .demo import load_demo
from .detect import detect_highlights
from .rules import load_rules


def main(argv=None):
    a = argparse.ArgumentParser(); a.add_argument("demo"); a.add_argument("--player"); a.add_argument("--rules")
    ns = a.parse_args(argv)
    k, r, ro, _ = load_demo(ns.demo)
    for h in detect_highlights(k, r, ro, load_rules(ns.rules), ns.player):
        print(f"{h.label:60} score={h.score} ticks={h.start_tick}-{h.end_tick}")


if __name__ == "__main__":
    main()
