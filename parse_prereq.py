"""Prose -> boolean prerequisite tree.

A small regex-based tokenizer feeds a hand-written recursive-descent parser.
Regex soup was deliberately avoided for the grammar itself (see the brief):
"and"/"or" nest with real operator precedence (AND binds tighter than OR,
matching how these sentences actually read), grade/concurrency/alpha-track
qualifiers scope over whole parenthesized groups, and a bare comma-separated
list with no explicit connector is genuinely ambiguous in English -- we still
have to produce *a* tree, so we default it to AND but flag the guess via
prereq_parse_status="partial" rather than presenting it as a confident read.

Leaf shapes:
  {"course": "MATH 243", "concurrent": true, "min_grade": "C", "or_higher": true}
  {"type": "consent"}
  {"type": "standing", "level": "junior", "or_higher": true}
  {"type": "major_restriction", "text": "..."}
  {"type": "unparsed", "text": "..."}
Every node may additionally carry "applies_to_alpha": "B" when the source
text tagged it "for (B)" (alpha-suffix-specific course families like
DNCE 400B/400C/...). Op nodes: {"op": "AND"|"OR"|"N_OF", "children": [...]},
N_OF also carries "n".
"""

import re
from collections import namedtuple

STANDING_LEVELS = {"freshman", "sophomore", "junior", "senior", "graduate", "undergraduate"}
WORD_NUMBERS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6}

Token = namedtuple("Token", ["kind", "value", "groups"])

# Order is priority: earlier patterns win at a given position. Matched as one
# combined alternation so tokenization is a single left-to-right scan. Inner
# captures use unique *named* groups -- their absolute index would otherwise
# shift depending on how many groups precede them in the alternation.
_TOKEN_SPEC = [
    ("NOFHEADER", r"^\s*(?P<nof_n>one|two|three|four|five|six|\d+)\s+of\s+the\s+following:?"),
    ("CONCURRENT", r"\(\s*or\s+concurrent\s*\)"),
    ("GRADE", r"with\s+an?\s*(?:minimum\s+)?grade\s+of\s+(?P<grade_letter>[A-D][+-]?)(?:\s*or\s*(?:better|higher))?"),
    ("ORHIGHER", r"\bor\s+higher\b"),
    ("FORALPHA", r"\bfor\s*\(\s*(?P<alpha_letter>[A-Z])\s*\)"),
    ("CONSENT", r"\b(?:(?:departmental|instructor|faculty|program|chair|department)\s+)?"
                r"(?:consent|permission|approval)\b"
                r"(?:\s+of\s+(?:the\s+)?(?:instructor|department|chair|program))?"),
    ("STANDING", r"\b(?P<standing_level>freshman|sophomore|junior|senior|graduate|undergraduate)\s+standing\b"),
    ("EITHER", r"\beither\b"),
    ("AND", r"\band\b"),
    ("OR", r"\bor\b"),
    ("COURSE", r"\b(?P<course_subj>[A-Z]{2,6})\s*(?P<course_num>\d{2,4}[A-Za-z]?)\b"),
    ("BARENUM", r"\b(?P<barenum>\d{2,4}[A-Za-z]?)\b"),
    ("LPAREN", r"[(\[]"),
    ("RPAREN", r"[)\]]"),
    ("SEMI", r";"),
    ("COMMA", r","),
    ("SLASH", r"/"),
    ("DOT", r"\."),
    ("WORD", r"\S+"),
]
_MASTER_RE = re.compile(
    "|".join(f"(?P<{name}>{pat})" for name, pat in _TOKEN_SPEC), re.IGNORECASE
)


def tokenize(text: str) -> list[Token]:
    tokens = []
    for m in _MASTER_RE.finditer(text):
        kind = m.lastgroup
        tokens.append(Token(kind, m.group(0), _extract_groups(kind, m)))
    return tokens


def _extract_groups(kind, m):
    if kind == "NOFHEADER":
        return (m.group("nof_n"),)
    if kind == "GRADE":
        return (m.group("grade_letter"),)
    if kind == "FORALPHA":
        return (m.group("alpha_letter").upper(),)
    if kind == "STANDING":
        return (m.group("standing_level").lower(),)
    if kind == "COURSE":
        return (m.group("course_subj").upper(), m.group("course_num"))
    if kind == "BARENUM":
        return (m.group("barenum"),)
    return ()


class ParseResult:
    def __init__(self):
        self.used_implicit_connector = False
        self.has_unparsed = False


class Parser:
    def __init__(self, tokens: list[Token], own_subject: str, result: ParseResult):
        self.tokens = tokens
        self.pos = 0
        self.own_subject = own_subject
        self.result = result

    def peek(self):
        return self.tokens[self.pos] if self.pos < len(self.tokens) else None

    def advance(self):
        tok = self.tokens[self.pos]
        self.pos += 1
        return tok

    def parse(self):
        if self.peek() and self.peek().kind == "NOFHEADER":
            tok = self.advance()
            n = WORD_NUMBERS.get(tok.groups[0].lower())
            if n is None:
                try:
                    n = int(tok.groups[0])
                except ValueError:
                    n = None
            children = self._parse_comma_list()
            node = {"op": "N_OF", "children": children}
            if n is not None:
                node["n"] = n
            return node
        if self.peek() is None:
            self.result.has_unparsed = True
            return {"type": "unparsed", "text": ""}
        return self.or_expr()

    def _parse_comma_list(self):
        children = []
        while True:
            self._skip(("DOT",))
            if self.peek() is None:
                break
            children.append(self.atom())
            if self.peek() and self.peek().kind == "COMMA":
                self.advance()
                continue
            break
        return children

    def _skip(self, kinds):
        while self.peek() and self.peek().kind in kinds:
            self.advance()

    def or_expr(self):
        nodes = [self.and_expr()]
        while True:
            tok = self.peek()
            if tok is None:
                break
            if tok.kind == "COMMA":
                # and_expr hands a comma back up here when it's immediately
                # followed by an explicit "or" (e.g. "A and B, or C") -- that
                # comma is this level's separator, not and_expr's.
                save = self.pos
                self.advance()
                if self.peek() and self.peek().kind == "OR":
                    self.advance()
                    self._skip(("EITHER",))
                    nodes.append(self.and_expr())
                    continue
                self.pos = save
                break
            if tok.kind == "OR":
                self.advance()
                self._skip(("EITHER",))
                nodes.append(self.and_expr())
            elif tok.kind == "SEMI":
                self.advance()
                if self.peek() and self.peek().kind == "OR":
                    self.advance()
                self._skip(("EITHER",))
                if self.peek() is None or self.peek().kind == "DOT":
                    break
                nodes.append(self.and_expr())
            else:
                break
        return nodes[0] if len(nodes) == 1 else {"op": "OR", "children": nodes}

    def and_expr(self):
        nodes = [self.atom()]
        while True:
            tok = self.peek()
            if tok is None:
                break
            if tok.kind == "AND":
                self.advance()
                nodes.append(self.atom())
            elif tok.kind == "COMMA":
                save = self.pos
                self.advance()
                nxt = self.peek()
                if nxt is None or nxt.kind == "DOT":
                    break
                if nxt.kind == "OR":
                    self.pos = save  # this comma belongs to the OR level; let it consume
                    break
                if nxt.kind == "AND":
                    self.advance()
                    nodes.append(self.atom())
                else:
                    self.result.used_implicit_connector = True
                    nodes.append(self.atom())
            else:
                break
        return nodes[0] if len(nodes) == 1 else {"op": "AND", "children": nodes}

    def atom(self):
        tok = self.peek()
        if tok is None:
            self.result.has_unparsed = True
            return {"type": "unparsed", "text": ""}

        if tok.kind == "EITHER":
            self.advance()
            return self.atom()

        if tok.kind == "LPAREN":
            self.advance()
            inner = self.or_expr()
            if self.peek() and self.peek().kind == "RPAREN":
                self.advance()
            return self._apply_group_modifiers(inner)

        if tok.kind in ("COURSE", "BARENUM"):
            return self._course_atom()

        if tok.kind == "CONSENT":
            self.advance()
            return {"type": "consent"}

        if tok.kind == "STANDING":
            self.advance()
            leaf = {"type": "standing", "level": tok.groups[0]}
            return self._apply_leaf_modifiers(leaf)

        return self._unparsed_atom()

    def _course_leaf(self):
        tok = self.advance()
        if tok.kind == "COURSE":
            return {"course": f"{tok.groups[0]} {tok.groups[1]}"}
        return {"course": f"{self.own_subject} {tok.groups[0]}"}

    def _course_atom(self):
        variants = [self._course_leaf()]
        while self.peek() and self.peek().kind == "SLASH":
            save = self.pos
            self.advance()
            if self.peek() and self.peek().kind in ("COURSE", "BARENUM"):
                variants.append(self._course_leaf())
            else:
                self.pos = save
                break
        node = variants[0] if len(variants) == 1 else {"op": "OR", "children": variants}
        return self._apply_leaf_modifiers(node) if len(variants) == 1 else self._apply_group_modifiers(node)

    def _apply_leaf_modifiers(self, leaf):
        while True:
            tok = self.peek()
            if tok is None:
                break
            if tok.kind == "CONCURRENT":
                self.advance()
                leaf["concurrent"] = True
            elif tok.kind == "GRADE":
                self.advance()
                leaf["min_grade"] = tok.groups[0]
            elif tok.kind == "ORHIGHER":
                self.advance()
                leaf["or_higher"] = True
            elif tok.kind == "FORALPHA":
                self.advance()
                leaf["applies_to_alpha"] = tok.groups[0]
            else:
                break
        return leaf

    def _apply_group_modifiers(self, node):
        while True:
            tok = self.peek()
            if tok is None:
                break
            if tok.kind == "GRADE":
                self.advance()
                self._apply_recursive(node, "min_grade", tok.groups[0])
            elif tok.kind == "ORHIGHER":
                self.advance()
                self._apply_recursive(node, "or_higher", True)
            elif tok.kind == "FORALPHA":
                self.advance()
                node["applies_to_alpha"] = tok.groups[0]
            elif tok.kind == "CONCURRENT":
                self.advance()
                node["concurrent"] = True
            else:
                break
        return node

    def _apply_recursive(self, node, key, value):
        if "course" in node:
            node[key] = value
        elif "children" in node:
            for child in node["children"]:
                self._apply_recursive(child, key, value)

    def _unparsed_atom(self):
        stop_kinds = ("AND", "OR", "SEMI", "COMMA", "RPAREN")
        parts = []
        while self.peek() and self.peek().kind not in stop_kinds:
            parts.append(self.advance().value)
        self.result.has_unparsed = True
        text = " ".join(parts).strip(" .")
        return {"type": "unparsed", "text": text}


def _has_any_unparsed(node) -> bool:
    if node.get("type") == "unparsed":
        return True
    if "children" in node:
        return any(_has_any_unparsed(c) for c in node["children"])
    return False


def _all_leaves_unparsed(node) -> bool:
    """True when nothing real was extracted at all -- no course/consent/
    standing leaf anywhere, just prose. Distinct from 'partial', which means
    mostly-structured with some residue."""
    if "children" in node:
        return all(_all_leaves_unparsed(c) for c in node["children"])
    return node.get("type") == "unparsed"


def parse_prereq(raw: str, own_subject: str) -> tuple[dict, str]:
    """Returns (tree, status) where status is 'clean', 'partial', or 'failed'."""
    if raw is None or not raw.strip():
        return None, "clean"

    tokens = tokenize(raw)
    result = ParseResult()
    parser = Parser(tokens, own_subject, result)
    tree = parser.parse()

    # Safety net: whatever the grammar didn't anticipate, never let it vanish.
    # Any tokens left unconsumed become a sibling unparsed leaf.
    parser._skip(("DOT",))
    if parser.pos < len(parser.tokens):
        leftover = " ".join(t.value for t in parser.tokens[parser.pos:]).strip(" .")
        if leftover:
            result.has_unparsed = True
            leftover_node = {"type": "unparsed", "text": leftover}
            tree = {"op": "AND", "children": [tree, leftover_node]}

    if _all_leaves_unparsed(tree):
        status = "failed"
    elif _has_any_unparsed(tree) or result.used_implicit_connector:
        status = "partial"
    else:
        status = "clean"
    return tree, status
