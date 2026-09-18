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
    # "N of ..." lead-in for a pick-N-of-these group. NOT anchored to the
    # start of the text -- it shows up mid-sentence just as often ("CINE
    # 350, and one of CINE 312, CINE 330, ..."), and every optional trailing
    # word here ("the following", "courses", ":") is decoration the catalog
    # sometimes skips ("one of: X, Y" / "one of X, Y" / "one of the
    # following: X, Y" / "one of the following courses: X, Y" all occur).
    ("NOFHEADER", r"\b(?:at\s+least\s+|any\s+)?(?P<nof_n>one|two|three|four|five|six|\d+)\s+of\b"
                  r"\s*(?:the\s+following\b\s*)?(?:courses?\b\s*)?:?"),
    ("CONCURRENT", r"\(\s*or\s+concurrent\s*\)"),
    # Four real phrasings seen in the catalog, all case-sensitive on the
    # grade letter itself (like subject codes, real grade letters are always
    # uppercase in the source -- avoids a bare lowercase "a"/"b" matching):
    #   "with a minimum grade of C" / "with a grade of C or better"
    #   "with a C- or better" / "with C- or better" (no "grade of")
    #   "C (not C-) or better in X" (no "with" at all)
    #   "C (not C-) in X" (CHEM 161: same "(not C-)" qualifier, but the
    #   catalog just drops "or better" entirely here -- the parenthetical
    #   alone is still a strong, narrow signal, so require it rather than
    #   matching a bare "C in X" that could be almost anything).
    ("GRADE", r"with\s+(?:an?\s+)?(?:minimum\s+)?grade\s+of\s+(?-i:(?P<grade_a>[A-D][+-]?))(?:\s*or\s*(?:better|higher))?"
              r"|with\s+(?:an?\s+)?(?-i:(?P<grade_b>[A-D][+-]?))\s*or\s*(?:better|higher)\b"
              r"|(?-i:(?P<grade_c>[A-D][+-]?))\s*(?:\(\s*not\s+(?-i:[A-D][+-]?)\s*\)\s*)?or\s+better\b"
              r"|(?-i:(?P<grade_d>[A-D][+-]?))\s*\(\s*not\s+(?-i:[A-D][+-]?)\s*\)\s*(?=in\b)"),
    ("ORHIGHER", r"\bor\s+higher\b"),
    ("FORALPHA", r"\bfor\s*\(\s*(?P<alpha_letter>[A-Z])\s*\)"),
    ("CONSENT", r"\b(?:(?:departmental|instructor|faculty|program|chair|department)\s+)?"
                r"(?:consent|permission|approval)\b"
                r"(?:\s+of\s+(?:the\s+)?(?:instructor|department|chair|program))?"),
    ("STANDING", r"\b(?P<standing_level>freshman|sophomore|junior|senior|graduate|undergraduate)\s+standing\b"),
    ("EITHER", r"\beither\b"),
    ("AND", r"\band\b"),
    ("OR", r"\bor\b"),
    # Subject codes are case-sensitive on purpose: with the master regex's
    # global IGNORECASE, lowercase English words like "any"/"one" in phrases
    # such as "any 100-level ERTH course" or "one 300-level ES course" would
    # otherwise match as fake subject codes ("ANY 100", "ONE 300"). Real
    # subject codes are always uppercase in the source HTML.
    ("COURSE", r"\b(?-i:(?P<course_subj>[A-Z]{2,6}))\s*(?P<course_num>\d{2,4}[A-Za-z]?)\b"),
    # A bare number followed by "credit(s)"/"unit(s)"/"hour(s)" is a credit
    # count ("30 or more credits"), not a same-subject course reference.
    ("BARENUM", r"\b(?P<barenum>\d{2,4}[A-Za-z]?)\b"
                r"(?!\s*(?:or\s+(?:more|fewer|less)\s+)?(?:credits?|units?|hours?)\b)"),
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
        return (m.group("grade_a") or m.group("grade_b") or m.group("grade_c") or m.group("grade_d"),)
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
        # Set by and_expr() on every call, read by or_expr() right after --
        # see and_expr()'s comma+AND branch and _fold note in or_expr().
        self._last_and_absorbable = False

    def peek(self):
        return self.tokens[self.pos] if self.pos < len(self.tokens) else None

    def advance(self):
        tok = self.tokens[self.pos]
        self.pos += 1
        return tok

    def parse(self):
        # NOFHEADER used to be special-cased here as a whole-text-only
        # construct, which meant a trailing "; or consent" after the list
        # got silently dropped (nothing consumed it) and a mid-sentence
        # "X, and one of Y, Z" never matched at all. It's now handled as a
        # regular atom() (see below), so it composes with the normal
        # AND/OR/SEMI continuation logic like anything else.
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
                # "one of A, B, C, or consent" -- a comma directly followed
                # by "or" doesn't belong to this list at all; it's the
                # outer expression's own elliptical-comma-before-"or"
                # ("...C, or consent" = "...C" OR "consent"), which
                # and_expr/or_expr already know how to unwind as long as
                # this comma is left for them, not swallowed into an empty
                # atom() call here (atom() has no OR case, so calling it
                # immediately after would silently return a zero-width
                # unparsed leaf and pollute the group with it).
                nxt = self.tokens[self.pos + 1] if self.pos + 1 < len(self.tokens) else None
                if nxt is not None and nxt.kind == "OR":
                    break
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
                # Elliptical comma ("A, B, or C") -- no literal "or" right
                # here, but a later "or" (not "and") governs the rest of
                # this list, same as if it had been spelled out at every
                # comma instead of just the last one.
                if self._peek_list_connector() == "OR":
                    nodes.append(self.and_expr())
                    continue
                self.pos = save
                break
            if tok.kind == "OR":
                self.advance()
                self._skip(("EITHER",))
                operand = self.and_expr()
                # "A or B, and C" -- and_expr() flags an operand like this
                # when it resolved a comma+"and" into a single plain leaf
                # tacked onto the very first thing it saw (e.g. "B, and C").
                # That leaf is a requirement that applies across every
                # alternative collected here, not just B: fold to
                # AND(OR(A, B), C) instead of leaving OR[A, AND(B, C)],
                # which would wrongly make A alone sufficient.
                if self._last_and_absorbable and operand.get("op") == "AND":
                    children = operand["children"]
                    nodes.append(children[0])
                    lhs = nodes[0] if len(nodes) == 1 else {"op": "OR", "children": list(nodes)}
                    nodes.clear()
                    nodes.append({"op": "AND", "children": [lhs] + children[1:]})
                else:
                    nodes.append(operand)
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

    # Same OR-with-comma-handoff logic as or_expr, but stops at a SEMI
    # (leaving it for the caller) instead of consuming it -- a semicolon
    # always introduces a new top-level alternative ("; or consent"), never
    # part of what "either" was scoping over.
    def _or_chain_no_semi(self):
        nodes = [self.and_expr()]
        while True:
            tok = self.peek()
            if tok is None:
                break
            if tok.kind == "COMMA":
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
            else:
                break
        return nodes[0] if len(nodes) == 1 else {"op": "OR", "children": nodes}

    def and_expr(self):
        nodes = [self.atom()]
        is_list_and = False
        while True:
            tok = self.peek()
            if tok is None:
                break
            if tok.kind == "AND":
                self.advance()
                nodes.append(self._atom_or_chain())
            elif tok.kind == "COMMA":
                save = self.pos
                self.advance()
                nxt = self.peek()
                if nxt is None or nxt.kind == "DOT":
                    break
                if nxt.kind == "OR":
                    self.pos = save  # this comma belongs to the OR level; let it consume
                    break
                if nxt.kind in ("GRADE", "ORHIGHER"):
                    # "ACC 323 and ACC 409, both with C- or better" -- this
                    # comma introduces a trailing modifier for the whole
                    # expression, not another atom to AND in. Let the
                    # top-level trailing-modifier pass in parse_prereq()
                    # handle it instead of swallowing it as unparsed text.
                    self.pos = save
                    break
                if nxt.kind == "WORD" and nxt.value.lower() in ("both", "each"):
                    self.pos = save
                    break
                if nxt.kind == "AND":
                    # "X, and Y or Z" -- the comma marks this "and" as
                    # starting a new list item rather than a tight X-and-Y
                    # coupling, so its RHS has to capture a whole following
                    # or-chain too ("Y or Z"), the same idea as the EITHER
                    # fix but keyed on the comma instead of that word.
                    self.advance()
                    was_first = len(nodes) == 1
                    rhs = self._or_chain_no_semi()
                    if isinstance(rhs, dict) and rhs.get("op") == "AND":
                        # No real "or" followed -- flatten instead of
                        # nesting AND-in-AND ("A, and B and C").
                        nodes.extend(rhs["children"])
                    else:
                        if was_first and (not isinstance(rhs, dict) or "op" not in rhs):
                            # Nothing accumulated yet, and the RHS is a
                            # single plain leaf ("B, and C") -- C is a
                            # candidate universal extra that an enclosing
                            # or_expr() may need to apply across every
                            # alternative, not just this one. See its
                            # "A or B, and C" handling.
                            is_list_and = True
                        nodes.append(rhs)
                else:
                    # Elliptical comma ("A, B, and C") -- check whether a
                    # later AND/OR actually governs this list instead of
                    # guessing. A later "or" means this comma belongs to
                    # the OR level instead; a later "and" confirms (not
                    # guesses) AND, so it doesn't count as an implicit
                    # connector; only a genuinely bare list ("A, B, C" with
                    # no and/or anywhere) is the real ambiguous guess.
                    connector = self._peek_list_connector()
                    if connector == "OR":
                        self.pos = save
                        break
                    if connector != "AND":
                        self.result.used_implicit_connector = True
                    nodes.append(self._atom_or_chain())
            else:
                break
        self._last_and_absorbable = is_list_and and len(nodes) > 1
        return nodes[0] if len(nodes) == 1 else {"op": "AND", "children": nodes}

    # "A or B or C", no commas at all -- used for one segment of a
    # comma-separated list once _peek_list_connector has already decided
    # the list's overall connector, so a segment's own internal
    # alternatives ("CHEM 162 or CHEM 171 or CHEM 181A" as the middle item
    # of "BIOL 171, CHEM 162 or CHEM 171 or CHEM 181A, PHYS 170, and
    # MATH 242 or MATH 252A") are captured as one OR-group instead of
    # calling atom() and grabbing only the first course, silently dropping
    # its "or"-alternatives on the floor. Deliberately does NOT recurse
    # into comma handling itself -- that would let it wander past its own
    # segment boundary and re-absorb the *next* list item too (verified
    # against the BE 260 case above, which is exactly what a naive
    # `self.and_expr()` here did).
    def _atom_or_chain(self):
        nodes = [self.atom()]
        while self.peek() and self.peek().kind == "OR":
            self.advance()
            self._skip(("EITHER",))
            nodes.append(self.atom())
        return nodes[0] if len(nodes) == 1 else {"op": "OR", "children": nodes}

    def _peek_list_connector(self):
        """Scans forward from the current position (without consuming) to
        find whichever of AND/OR governs the *overall* comma-separated
        list. Ignores connectors inside a nested parenthesized group.

        "and" and "or" are trusted very differently here, on purpose:

        An "and" found *anywhere* ahead is always safe to trust immediately,
        even buried inside what will turn out to be one single list item
        ("SPED 606, SPED 607 and SPED 608" -- the "and" sits between 607
        and 608, not between the whole list and something else, but the
        module docstring's own default for a genuinely ambiguous list is
        already AND, so an "and" anywhere only ever confirms that default,
        never overturns it).

        "or" gets the opposite treatment: only the "or" introducing the
        LAST comma-delimited segment counts. A middle segment can carry
        its own internal "X or Y or Z" alternation with no comma of its
        own ("BIOL 171, CHEM 162 or CHEM 171 or CHEM 181A, PHYS 170, and
        MATH 242 or MATH 252A" is AND-of-four, but the first connector
        encountered scanning left to right is the "or" inside segment 2 --
        trusting that instead of the "and" actually introducing the last
        segment wrongly turned the whole list into one big OR). Mistaking
        a middle segment's own "or" for the list's connector is the one
        direction with a real, confirmed bug behind it; mistaking a final
        segment's leading "or" is comparatively rare and, when genuinely
        ambiguous, still falls back to the same safe AND-and-flag-partial
        default as everything else.
        """
        depth = 0
        segments = [[]]
        for tok in self.tokens[self.pos:]:
            if tok.kind == "LPAREN":
                depth += 1
                segments[-1].append(tok)
            elif tok.kind == "RPAREN":
                if depth == 0:
                    break
                depth -= 1
                segments[-1].append(tok)
            elif depth == 0:
                if tok.kind in ("SEMI", "DOT"):
                    break
                if tok.kind == "COMMA":
                    segments.append([])
                    continue
                segments[-1].append(tok)
            else:
                segments[-1].append(tok)

        for seg in segments:
            for tok in seg:
                if tok.kind == "AND":
                    return "AND"

        if len(segments) >= 2 and segments[-1] and segments[-1][0].kind == "OR":
            return "OR"
        return None

    def atom(self):
        tok = self.peek()
        if tok is None:
            self.result.has_unparsed = True
            return {"type": "unparsed", "text": ""}

        if tok.kind == "EITHER":
            # "X and either Y or Z" means X AND (Y OR Z) -- "either" scopes
            # over the whole Y-or-Z-or-... chain that follows it, not just
            # the single atom immediately after it. Consuming only one atom
            # here (the old behavior) let a later "and_expr" swallow just Y
            # into the same AND as X, leaving Z dangling as a bare top-level
            # OR-sibling -- "ECE 315 and either MATH 244 or MATH 253A" was
            # parsing as OR[AND(ECE315, MATH244), MATH253A] instead of the
            # correct AND(ECE315, OR(MATH244, MATH253A)).
            self.advance()
            return self._or_chain_no_semi()

        if tok.kind == "GRADE":
            # "C (not C-) or better in BIOL 171 / BIOL 171L, BIOL 172 ..." --
            # the grade leads here rather than trailing the course(s) it
            # modifies. Consume it, skip a literal "in" if present, parse
            # whatever follows as its own (possibly and/or/slash) group, and
            # apply the grade recursively to that whole group.
            self.advance()
            if self.peek() and self.peek().kind == "WORD" and self.peek().value.lower() == "in":
                self.advance()
            sub = self.or_expr()
            self._apply_recursive(sub, "min_grade", tok.groups[0])
            return sub

        if tok.kind == "NOFHEADER":
            # "one of X, Y, Z" -- a comma list is genuinely only a real
            # alternative-group signal here because "one of"/"two of" said
            # so explicitly; a bare comma list elsewhere still defaults to
            # AND (see and_expr) since it's otherwise ambiguous. Handling
            # this as a plain atom (rather than only at the very start of
            # the whole text, as before) means it also works mid-sentence
            # ("CINE 350, and one of X, Y") and composes with whatever
            # trails the list (e.g. "; or consent") through the normal
            # and_expr/or_expr continuation logic instead of that tail
            # silently being dropped.
            self.advance()
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
            return self._apply_group_modifiers(node)

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
        if len(variants) == 2 and _is_lab_pair(variants[0]["course"], variants[1]["course"]):
            # "BIOL 172 / BIOL 172L" -- the lab section of the same course,
            # both genuinely required together, not an alternative to it.
            # The catalog's "/" is otherwise ambiguous between this and a
            # cross-listing ("ARCH 628 / PLAN 675", the same course offered
            # by two departments -- either satisfies it, a real OR), but a
            # same-subject pair differing only by a trailing lab "L" is
            # unambiguous, so it's the one case worth special-casing rather
            # than defaulting every "/" to OR.
            node = {"op": "AND", "children": variants}
        else:
            node = variants[0] if len(variants) == 1 else {"op": "OR", "children": variants}
        return self._apply_leaf_modifiers(node) if len(variants) == 1 else self._apply_group_modifiers(node)

    # A modifier can trail an atom bare ("ACC 200 with a C- or better") or
    # wrapped in its own parens ("ACC 200 (with a C- or better)") -- the
    # latter is common enough in the catalog that both forms need handling.
    # Returns the modifier token and advances past it (and its wrapping
    # parens, if any); returns None and consumes nothing otherwise.
    def _take_modifier_token(self, kinds):
        tok = self.peek()
        if tok is not None and tok.kind in kinds:
            self.advance()
            return tok
        if tok is not None and tok.kind == "LPAREN":
            inner = self.tokens[self.pos + 1] if self.pos + 1 < len(self.tokens) else None
            after = self.tokens[self.pos + 2] if self.pos + 2 < len(self.tokens) else None
            if inner is not None and inner.kind in kinds and after is not None and after.kind == "RPAREN":
                self.advance()
                self.advance()
                self.advance()
                return inner
        return None

    def _apply_leaf_modifiers(self, leaf):
        kinds = ("CONCURRENT", "GRADE", "ORHIGHER", "FORALPHA")
        while True:
            tok = self._take_modifier_token(kinds)
            if tok is None:
                break
            if tok.kind == "CONCURRENT":
                leaf["concurrent"] = True
            elif tok.kind == "GRADE":
                leaf["min_grade"] = tok.groups[0]
            elif tok.kind == "ORHIGHER":
                leaf["or_higher"] = True
            elif tok.kind == "FORALPHA":
                leaf["applies_to_alpha"] = tok.groups[0]
        return leaf

    def _apply_group_modifiers(self, node):
        kinds = ("GRADE", "ORHIGHER", "FORALPHA", "CONCURRENT")
        while True:
            tok = self._take_modifier_token(kinds)
            if tok is None:
                break
            if tok.kind == "GRADE":
                self._apply_recursive(node, "min_grade", tok.groups[0])
            elif tok.kind == "ORHIGHER":
                self._apply_recursive(node, "or_higher", True)
            elif tok.kind == "FORALPHA":
                node["applies_to_alpha"] = tok.groups[0]
            elif tok.kind == "CONCURRENT":
                node["concurrent"] = True
        return node

    def _apply_recursive(self, node, key, value):
        _apply_recursive(node, key, value)

    def _unparsed_atom(self):
        stop_kinds = ("AND", "OR", "SEMI", "COMMA", "RPAREN")
        parts = []
        while self.peek() and self.peek().kind not in stop_kinds:
            parts.append(self.advance().value)
        self.result.has_unparsed = True
        text = " ".join(parts).strip(" .")
        return {"type": "unparsed", "text": text}


def _apply_recursive(node, key, value):
    if "course" in node:
        node[key] = value
    elif "children" in node:
        for child in node["children"]:
            _apply_recursive(child, key, value)


def _is_lab_pair(course_a: str, course_b: str) -> bool:
    """True for "BIOL 172" / "BIOL 172L" -- same subject, one course number
    is the other with a trailing lab "L" appended (either order: the raw
    text sometimes lists the lab section first)."""
    subj_a, num_a = course_a.split(" ", 1)
    subj_b, num_b = course_b.split(" ", 1)
    return subj_a == subj_b and (num_a + "L" == num_b or num_b + "L" == num_a)


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

    # A grade/or-higher modifier can trail the WHOLE expression rather than a
    # single parenthesized group -- "ACC 323 and ACC 409, both with C- or
    # better." Look past filler (comma, "both") for one; if found, consume
    # it and apply recursively to the whole tree. If not, revert entirely
    # (don't eat real content on a failed guess) and let the safety net below
    # carry it as unparsed instead.
    _FILLER_WORDS = {"both", "each"}
    save_pos = parser.pos
    applied_trailing = False
    while True:
        tok = parser.peek()
        if tok is None:
            break
        if tok.kind in ("COMMA", "DOT"):
            parser.advance()
            continue
        if tok.kind == "WORD" and tok.value.lower() in _FILLER_WORDS:
            parser.advance()
            continue
        if tok.kind == "GRADE":
            parser.advance()
            _apply_recursive(tree, "min_grade", tok.groups[0])
            applied_trailing = True
            continue
        if tok.kind == "ORHIGHER":
            parser.advance()
            _apply_recursive(tree, "or_higher", True)
            applied_trailing = True
            continue
        break
    if not applied_trailing:
        parser.pos = save_pos

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
