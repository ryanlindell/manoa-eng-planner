"""Builds the prereq graph for the 2022-23 catalog, via graph.py's own
build() -- pointed at data_2022/ instead of the CATOID/DATA_DIR-keyed paths
graph.py's main() uses by default (this catalog isn't a catoid at all, same
as 2024-25 -- see scripts/graph_2024.py).

Writes visualizer/data/prereq_graph_2022.json -- add a matching "2022" entry
to visualizer/app.js's CATALOGS array to make it selectable.
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import graph  # noqa: E402

DATA_PATH = ROOT / "data_2022"
VISUALIZER_JSON = ROOT / "visualizer" / "data" / "prereq_graph_2022.json"

if __name__ == "__main__":
    graph.build(
        in_jsonl=DATA_PATH / "courses.jsonl",
        out_pickle=DATA_PATH / "prereq_graph.gpickle",
        out_json=DATA_PATH / "prereq_graph.json",
        out_report=DATA_PATH / "graph_report.txt",
        visualizer_json=VISUALIZER_JSON,
    )
