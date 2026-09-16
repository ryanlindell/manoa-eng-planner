"""Build the prerequisite graph from data/courses.jsonl and analyze it:
cycles, dangling references, and an AND/OR/N_OF-aware topological depth per
course (not a naive graph distance -- see depth_for_tree below).

Outputs: data/prereq_graph.gpickle (networkx object), data/prereq_graph.json
(plain adjacency + per-node depth, for the eventual web app to read without
Python), data/graph_report.txt (cycles, dangling refs, depth distribution).
"""

import json
import pickle
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import networkx as nx

from config import DATA_DIR

DATA_PATH = Path(DATA_DIR)
IN_JSONL = DATA_PATH / "courses.jsonl"
OUT_PICKLE = DATA_PATH / "prereq_graph.gpickle"
OUT_JSON = DATA_PATH / "prereq_graph.json"
OUT_REPORT = DATA_PATH / "graph_report.txt"
# The visualizer fetches "data/prereq_graph.json" relative to its own
# index.html, matching how the published Artifact serves supporting files
# (relative to the page, no parent directory to go up to) -- so a second
# copy has to live under visualizer/ for local static-file serving to work
# the same way. Written together so they can't drift out of sync.
VISUALIZER_JSON = Path(__file__).resolve().parent / "visualizer" / "data" / "prereq_graph.json"

NON_COURSE_LEAF_TYPES = {"consent", "standing", "major_restriction", "unparsed"}


def load_real_courses() -> dict[str, dict]:
    courses = {}
    for line in IN_JSONL.open(encoding="utf-8"):
        c = json.loads(line)
        if c["parse_status"] == "ok" and not c["is_alpha_parent"]:
            courses[c["code"]] = c
    return courses


def extract_course_refs(tree) -> list[str]:
    """All course codes mentioned anywhere in a tree, AND/OR distinction
    ignored -- this is for graph edges (existence of a dependency), not depth."""
    if tree is None:
        return []
    refs = []

    def walk(node):
        if "course" in node:
            refs.append(node["course"])
        elif "children" in node:
            for child in node["children"]:
                walk(child)

    walk(tree)
    return refs


def _mentions_course(node) -> bool:
    if "course" in node:
        return True
    if "children" in node:
        return any(_mentions_course(c) for c in node["children"])
    return False


def build_graph(courses: dict[str, dict]) -> nx.DiGraph:
    g = nx.DiGraph()
    for code, c in courses.items():
        g.add_node(
            code,
            title=c["title"],
            subject=c["subject"],
            credits_raw=c["credits_raw"],
            credits_min=c["credits_min"],
            credits_max=c["credits_max"],
            gened=c["gened"],
            description=c["description"],
            prereq_raw=c["prereq_raw"],
            coreq_raw=c["coreq_raw"],
            restrictions_raw=c["restrictions_raw"],
            source_url=c["source_url"],
            in_catalog=True,
        )

    for code, c in courses.items():
        for prereq_code in extract_course_refs(c.get("prereq_tree")):
            if prereq_code not in g:
                g.add_node(prereq_code, in_catalog=False)
            g.add_edge(prereq_code, code, type="prereq")
        for coreq_code in extract_course_refs(c.get("coreq_tree")):
            if coreq_code not in g:
                g.add_node(coreq_code, in_catalog=False)
            if not g.has_edge(coreq_code, code):
                g.add_edge(coreq_code, code, type="coreq")

    return g


def find_cycles(g: nx.DiGraph) -> list[list[str]]:
    """Real cycles among *prereq* edges only -- a coreq pair (A requires B
    concurrently and vice versa, e.g. a lecture/lab pair) is normal, not a
    genuine ordering problem, so it's deliberately excluded here."""
    prereq_edges = [(u, v) for u, v, d in g.edges(data=True) if d.get("type") == "prereq"]
    prereq_graph = nx.DiGraph(prereq_edges)
    return [list(scc) for scc in nx.strongly_connected_components(prereq_graph) if len(scc) > 1]


def compute_depths(courses: dict[str, dict]) -> tuple[dict[str, int | None], dict[str, str]]:
    """Recursively evaluates each course's prereq_tree respecting AND/OR/N_OF
    semantics -- NOT a flat graph-distance calculation. See the module
    docstring and the design note in the strategy discussion:
      - course leaf: 1 + depth(that course)
      - consent/standing/major_restriction/unparsed leaf: 0 (doesn't block on
        a course)
      - AND: max(children) -- must satisfy all, bounded by the slowest
      - OR: min(children), but preferring course-bearing branches over a bare
        consent/standing escape hatch when at least one course path exists
        (otherwise "or consent" would trivialize every depth to near-zero)
      - N_OF(n): the n-th smallest child depth (need n satisfied)
    Coreqs are NOT factored in here (see graph.py docstring) -- a documented
    simplification, not an oversight.
    """
    depth_cache: dict[str, int | None] = {}
    depth_status: dict[str, str] = {}
    visiting: set[str] = set()

    def tree_depth(node):
        if "course" in node:
            sub = course_depth(node["course"])
            return None if sub is None else sub + 1
        if node.get("type") in NON_COURSE_LEAF_TYPES:
            return 0
        op = node.get("op")
        children = node.get("children", [])
        results = [tree_depth(c) for c in children]
        if op == "AND":
            if any(r is None for r in results):
                return None
            return max(results) if results else 0
        if op == "OR":
            course_bearing = [r for c, r in zip(children, results) if _mentions_course(c) and r is not None]
            resolved = [r for r in results if r is not None]
            pool = course_bearing if course_bearing else resolved
            return min(pool) if pool else None
        if op == "N_OF":
            n = node.get("n", len(children))
            resolved = sorted(r for r in results if r is not None)
            return resolved[n - 1] if len(resolved) >= n else None
        return 0

    def course_depth(code):
        if code in depth_cache:
            return depth_cache[code]
        if code not in courses:
            depth_cache[code] = 0
            depth_status[code] = "external"
            return 0
        if code in visiting:
            return None  # signal only -- the outer call in this chain caches the real result
        visiting.add(code)
        c = courses[code]
        tree = c.get("prereq_tree")
        if tree is None:
            d = 0
            status = "no_prereq" if not c.get("prereq_raw") else "unresolved_prereq"
        else:
            d = tree_depth(tree)
            if d is None:
                status = "cycle"
            elif c.get("prereq_parse_status") == "failed":
                status = "unresolved_prereq"
            else:
                status = "ok"
        visiting.discard(code)
        depth_cache[code] = d
        depth_status[code] = status
        return d

    for code in courses:
        course_depth(code)

    return depth_cache, depth_status


def find_dangling_refs(g: nx.DiGraph, courses: dict[str, dict]) -> dict[str, list[str]]:
    """Codes referenced as a prereq/coreq but not present in our dataset --
    typos, retired courses, or cross-campus codes."""
    dangling = defaultdict(list)
    for code, c in courses.items():
        for ref in extract_course_refs(c.get("prereq_tree")) + extract_course_refs(c.get("coreq_tree")):
            if ref not in courses:
                dangling[ref].append(code)
    return dict(dangling)


def export_json(g: nx.DiGraph, depths, depth_status):
    nodes = {}
    for code, attrs in g.nodes(data=True):
        nodes[code] = {
            **{k: v for k, v in attrs.items()},
            "depth": depths.get(code),
            "depth_status": depth_status.get(code, "external"),
        }
    edges = [{"from": u, "to": v, "type": d.get("type")} for u, v, d in g.edges(data=True)]
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "node_count": g.number_of_nodes(),
        "edge_count": g.number_of_edges(),
        "nodes": nodes,
        "edges": edges,
    }
    text = json.dumps(payload, ensure_ascii=False, indent=1)
    OUT_JSON.write_text(text, encoding="utf-8")
    VISUALIZER_JSON.parent.mkdir(parents=True, exist_ok=True)
    VISUALIZER_JSON.write_text(text, encoding="utf-8")


def build_report(g, courses, cycles, dangling, depths, depth_status) -> str:
    lines = []
    lines.append("=== UH Manoa Catalog -- Prereq Graph Report ===")
    lines.append(f"Nodes: {g.number_of_nodes()} (in-catalog: {sum(1 for _, d in g.nodes(data=True) if d.get('in_catalog'))}, "
                 f"external/unresolved: {sum(1 for _, d in g.nodes(data=True) if not d.get('in_catalog'))})")
    lines.append(f"Edges: {g.number_of_edges()} "
                 f"(prereq: {sum(1 for *_, d in g.edges(data=True) if d.get('type')=='prereq')}, "
                 f"coreq: {sum(1 for *_, d in g.edges(data=True) if d.get('type')=='coreq')})")

    lines.append("")
    lines.append(f"Cycles detected (prereq edges only): {len(cycles)}")
    for cyc in cycles[:20]:
        lines.append(f"  {sorted(cyc)}")

    lines.append("")
    lines.append(f"Dangling references (mentioned but not in dataset): {len(dangling)} distinct codes")
    top_dangling = sorted(dangling.items(), key=lambda kv: -len(kv[1]))[:20]
    for code, referenced_by in top_dangling:
        lines.append(f"  {code}: referenced by {len(referenced_by)} course(s), e.g. {referenced_by[:3]}")

    status_counts = defaultdict(int)
    for s in depth_status.values():
        status_counts[s] += 1
    lines.append("")
    lines.append("Depth status breakdown (all graph nodes):")
    for status in ("ok", "no_prereq", "unresolved_prereq", "cycle", "external"):
        lines.append(f"  {status}: {status_counts.get(status, 0)}")

    resolved = [(code, d) for code, d in depths.items() if d is not None and code in courses]
    if resolved:
        vals = [d for _, d in resolved]
        lines.append("")
        lines.append(f"Depth distribution (in-catalog courses with a resolvable depth, n={len(vals)}):")
        lines.append(f"  min={min(vals)} max={max(vals)} mean={sum(vals)/len(vals):.2f}")
        hist = defaultdict(int)
        for v in vals:
            hist[v] += 1
        for depth in sorted(hist):
            lines.append(f"  depth {depth}: {hist[depth]} courses")

        deepest = sorted(resolved, key=lambda kv: -kv[1])[:15]
        lines.append("")
        lines.append("Deepest courses:")
        for code, d in deepest:
            lines.append(f"  {code}: depth {d} -- {courses[code]['title']}")

    return "\n".join(lines) + "\n"


def main():
    courses = load_real_courses()
    g = build_graph(courses)
    cycles = find_cycles(g)
    dangling = find_dangling_refs(g, courses)
    depths, depth_status = compute_depths(courses)

    DATA_PATH.mkdir(parents=True, exist_ok=True)
    with open(OUT_PICKLE, "wb") as f:
        pickle.dump(g, f)
    export_json(g, depths, depth_status)

    report = build_report(g, courses, cycles, dangling, depths, depth_status)
    OUT_REPORT.write_text(report, encoding="utf-8")
    print(report)


if __name__ == "__main__":
    main()
