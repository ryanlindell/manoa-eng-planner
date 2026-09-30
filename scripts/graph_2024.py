"""Builds the prereq graph for the 2024-25 catalog, via graph.py's own
build() (see that module for what this actually does) -- just pointed at
data_2024/ instead of the CATOID/DATA_DIR-keyed paths graph.py's main()
uses by default, since this catalog isn't a catoid at all (see
data_2024/README.md).

Writes visualizer/data/prereq_graph_2024.json, matching the id used for it
in visualizer/app.js's CATALOGS array.
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import graph  # noqa: E402

DATA_PATH = ROOT / "data_2024"
VISUALIZER_JSON = ROOT / "visualizer" / "data" / "prereq_graph_2024.json"

if __name__ == "__main__":
    graph.build(
        in_jsonl=DATA_PATH / "courses.jsonl",
        out_pickle=DATA_PATH / "prereq_graph.gpickle",
        out_json=DATA_PATH / "prereq_graph.json",
        out_report=DATA_PATH / "graph_report.txt",
        visualizer_json=VISUALIZER_JSON,
    )
